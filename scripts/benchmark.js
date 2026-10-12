#!/usr/bin/env node
/**
 * Reproducible benchmark suite against the docker compose stack.
 *
 *   docker compose up -d --build
 *   node scripts/benchmark.js --reset-db
 *
 * Every number is derived from timestamps Postgres recorded for each job
 * (created_at, started_at, finished_at), not from client-side estimates.
 *
 * --reset-db TRUNCATEs jobs/outbox between scenarios. Only use it on a dedicated
 * benchmark database.
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const { parseArgs } = require('util');
const { execFileSync } = require('child_process');

process.env.LOG_LEVEL ||= 'silent';
const { db, closeRedis } = require('@scheduler/core');

const { values: args } = parseArgs({
  options: {
    url: { type: 'string', default: process.env.BASE_URL || 'http://localhost:8000' },
    key: { type: 'string', default: process.env.API_KEY || '' },
    project: { type: 'string', default: process.env.COMPOSE_PROJECT_NAME || '' },
    only: { type: 'string' }, // comma-separated scenario names
    files: { type: 'string', default: process.env.COMPOSE_FILES || '' }, // e.g. docker-compose.yml,docker-compose.bench.yml
    'reset-db': { type: 'boolean', default: false },
    'work-ms': { type: 'string', default: '10' },
    scale: { type: 'string', default: '1,2,4' },
    trials: { type: 'string', default: '3' },
    rates: { type: 'string', default: 'auto' }, // auto = 25/50/75% of measured ingest capacity
    out: { type: 'string', default: path.join(__dirname, '..', 'docs', 'benchmarks') },
  },
});

const WORK_MS = Number(args['work-ms']);
const headers = { 'content-type': 'application/json', ...(args.key ? { 'x-api-key': args.key } : {}) };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
const round = (n, d = 1) => Math.round(n * 10 ** d) / 10 ** d;
const log = (...a) => console.log(...a);

const composeFiles = () => (args.files ? args.files.split(',').flatMap((f) => ['-f', f]) : []);
const compose = (...cmd) => {
  const base = ['compose', ...(args.project ? ['-p', args.project] : []), ...composeFiles()];
  execFileSync('docker', [...base, ...cmd], { stdio: ['ignore', 'ignore', 'inherit'], env: process.env });
};
const scaleWorkers = async (n) => {
  compose('up', '-d', '--no-deps', '--scale', `worker=${n}`, 'worker');
  await sleep(n > 0 ? 3000 : 1000); // let workers boot and join the consumer group
};

// CPU / memory caps of each service, read from the effective compose config.
const composeLimits = () => {
  try {
    const base = ['compose', ...(args.project ? ['-p', args.project] : []), ...composeFiles(), 'config', '--format', 'json'];
    const cfg = JSON.parse(execFileSync('docker', base, { env: process.env, stdio: ['ignore', 'pipe', 'ignore'] }));
    const out = {};
    for (const [name, svc] of Object.entries(cfg.services)) {
      const l = svc.deploy?.resources?.limits;
      if (l) out[name] = { cpus: Number(l.cpus), memoryMb: Math.round(Number(l.memory) / 1024 ** 2) };
    }
    return out;
  } catch {
    return null;
  }
};

const resetDb = async () => {
  if (args['reset-db']) await db.pool.query('TRUNCATE jobs, outbox CASCADE');
};

const job = (runId) => ({ type: 'demo', payload: { durationMs: WORK_MS, runId } });

const post = async (body, batch) => {
  for (;;) {
    const res = await fetch(`${args.url}/jobs${batch ? '/batch' : ''}`, {
      method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
    }).catch(() => null);
    if (res) await res.text();
    if (res && (res.status === 201 || res.status === 200)) return;
    if (res && res.status !== 429 && res.status < 500) throw new Error(`unexpected status ${res.status}`);
    await sleep(100);
  }
};

// Closed loop: `clients` concurrent senders, each waits for its response before sending again.
const closedLoop = async ({ runId, total, clients, batch }) => {
  const latencies = [];
  const requests = Math.ceil(total / batch);
  let next = 0;
  const t0 = performance.now();
  await Promise.all(Array.from({ length: clients }, async () => {
    while (next < requests) {
      const i = next++;
      const size = Math.min(batch, total - i * batch);
      const start = performance.now();
      if (batch === 1) await post(job(runId), false);
      else await post({ jobs: Array.from({ length: size }, () => job(runId)) }, true);
      latencies.push(performance.now() - start);
    }
  }));
  const seconds = (performance.now() - t0) / 1000;
  latencies.sort((a, b) => a - b);
  return {
    seconds: round(seconds, 2),
    jobsPerSec: Math.round(total / seconds),
    requestP50Ms: round(pct(latencies, 0.5)),
    requestP99Ms: round(pct(latencies, 0.99)),
  };
};

// Open loop: a fixed arrival rate regardless of how fast responses come back. This is
// how real traffic behaves, and it avoids "coordinated omission" in latency numbers.
const MAX_IN_FLIGHT = 500;
const openLoop = async ({ runId, rate, seconds }) => {
  const inflight = [];
  let active = 0;
  let sent = 0;
  let saturated = false;
  const t0 = performance.now();
  const end = t0 + seconds * 1000;
  // Send based on elapsed wall time, so a slow tick is caught up instead of silently
  // lowering the offered rate. If the system can't keep up, in-flight requests pile up;
  // past MAX_IN_FLIGHT we stop and flag the run as saturated rather than hide it.
  while (performance.now() < end) {
    const due = Math.floor(((performance.now() - t0) / 1000) * rate);
    while (sent < due) {
      if (active >= MAX_IN_FLIGHT) {
        saturated = true;
        break;
      }
      active++;
      inflight.push(post(job(runId), false).finally(() => { active--; }));
      sent++;
    }
    if (saturated) break;
    await sleep(5);
  }
  await Promise.all(inflight);
  return { sent, achievedRate: Math.round(sent / ((performance.now() - t0) / 1000)), saturated };
};

const waitDone = async (runId, total, timeoutMs = 600000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { rows } = await db.pool.query(
      `SELECT count(*) FILTER (WHERE status IN ('SUCCEEDED', 'DEAD'))::int AS done FROM jobs WHERE payload->>'runId' = $1`,
      [runId],
    );
    process.stdout.write(`\r    completed ${rows[0].done}/${total}   `);
    if (rows[0].done >= total) {
      process.stdout.write('\n');
      return;
    }
    await sleep(500);
  }
  throw new Error(`run ${runId} did not finish`);
};

const waitRelayed = async () => {
  for (;;) {
    const { rows } = await db.pool.query('SELECT count(*)::int AS n FROM outbox');
    if (rows[0].n === 0) return;
    await sleep(200);
  }
};

// Percentiles and throughput straight from the jobs table.
const jobStats = async (runId) => {
  const { rows: [r] } = await db.pool.query(
    `SELECT count(*)::int AS jobs,
            count(*) FILTER (WHERE status = 'SUCCEEDED')::int AS succeeded,
            count(*) FILTER (WHERE attempts > 1)::int AS retried,
            percentile_cont(ARRAY[0.5, 0.95, 0.99]) WITHIN GROUP (ORDER BY extract(epoch FROM started_at - created_at) * 1000) AS queue_ms,
            percentile_cont(ARRAY[0.5, 0.95, 0.99]) WITHIN GROUP (ORDER BY extract(epoch FROM finished_at - created_at) * 1000) AS e2e_ms,
            extract(epoch FROM max(finished_at) - min(created_at)) AS span_s,
            extract(epoch FROM max(finished_at) - min(started_at)) AS drain_s
     FROM jobs WHERE payload->>'runId' = $1`,
    [runId],
  );
  return {
    jobs: r.jobs,
    succeeded: r.succeeded,
    retried: r.retried,
    queueLatencyMs: { p50: round(r.queue_ms[0]), p95: round(r.queue_ms[1]), p99: round(r.queue_ms[2]) },
    endToEndMs: { p50: round(r.e2e_ms[0]), p95: round(r.e2e_ms[1]), p99: round(r.e2e_ms[2]) },
    endToEndJobsPerSec: Math.round(r.jobs / Number(r.span_s)),
    drainJobsPerSec: Math.round(r.jobs / Number(r.drain_s)),
  };
};

const runId = (name) => `bench-${name}-${Date.now()}`;

// Field-wise median across trials (numbers only), so one noisy run can't skew a result.
const medianOf = (objs) => {
  const first = objs[0];
  if (typeof first === 'number') {
    const s = [...objs].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  }
  if (first && typeof first === 'object' && !Array.isArray(first)) {
    return Object.fromEntries(Object.keys(first).map((k) => [k, medianOf(objs.map((o) => o[k]))]));
  }
  return first;
};

const trials = async (label, fn) => {
  const n = Number(args.trials);
  const runs = [];
  for (let i = 1; i <= n; i++) {
    const r = await fn();
    log(`    ${label} trial ${i}/${n}: ${JSON.stringify(r.summary)}`);
    runs.push(r.data);
  }
  return { median: medianOf(runs), trials: runs };
};

const scenarios = {
  // How fast the API can durably accept work (Postgres insert + outbox, one transaction).
  async ingest() {
    await scaleWorkers(2);
    const single = await trials('single-job requests', async () => {
      await resetDb();
      const r = await closedLoop({ runId: runId('ingest1'), total: 5000, clients: 32, batch: 1 });
      return { data: r, summary: { jobsPerSec: r.jobsPerSec, p99: r.requestP99Ms } };
    });
    const batch = await trials('batches of 100', async () => {
      await resetDb();
      const r = await closedLoop({ runId: runId('ingestB'), total: 20000, clients: 8, batch: 100 });
      return { data: r, summary: { jobsPerSec: r.jobsPerSec, p99: r.requestP99Ms } };
    });
    return {
      single: { jobs: 5000, clients: 32, ...single },
      batch100: { jobs: 20000, clients: 8, ...batch },
    };
  },

  // Processing capacity vs worker count: preload a backlog with workers stopped, then
  // start N workers and time the drain.
  async scaling() {
    const out = [];
    for (const n of args.scale.split(',').map(Number)) {
      const r = await trials(`${n} worker(s)`, async () => {
        await resetDb();
        await scaleWorkers(0);
        const id = runId(`scale${n}`);
        const total = 10000;
        await closedLoop({ runId: id, total, clients: 8, batch: 100 });
        await waitRelayed();
        await scaleWorkers(n);
        await waitDone(id, total);
        const s = await jobStats(id);
        return { data: { drainJobsPerSec: s.drainJobsPerSec, succeeded: s.succeeded }, summary: { jobsPerSec: s.drainJobsPerSec, ok: s.succeeded } };
      });
      out.push({ workers: n, jobs: 10000, ...r });
    }
    const base = out[0].median.drainJobsPerSec;
    for (const r of out) r.speedupVs1 = round(r.median.drainJobsPerSec / base, 2);
    await scaleWorkers(2);
    return out;
  },

  // Latency under steady load (open loop, fixed arrival rate).
  async latency(results) {
    const out = [];
    await scaleWorkers(2);
    let rates;
    if (args.rates !== 'auto') rates = args.rates.split(',').map(Number);
    else {
      const capacity = results.scenarios.ingest?.single.median.jobsPerSec;
      rates = capacity ? [0.25, 0.5, 0.75].map((f) => Math.max(10, Math.round((capacity * f) / 10) * 10)) : [50, 100, 200];
    }
    for (const rate of rates) {
      const r = await trials(`${rate} jobs/s`, async () => {
        await resetDb();
        const id = runId(`lat${rate}`);
        const { sent, achievedRate, saturated } = await openLoop({ runId: id, rate, seconds: 20 });
        await waitDone(id, sent);
        const s = await jobStats(id);
        return {
          data: { jobs: sent, achievedRate, saturated, queueLatencyMs: s.queueLatencyMs, endToEndMs: s.endToEndMs, succeeded: s.succeeded },
          summary: { achievedRate, saturated, queueP50: s.queueLatencyMs.p50, queueP99: s.queueLatencyMs.p99, e2eP99: s.endToEndMs.p99 },
        };
      });
      out.push({ ratePerSec: rate, durationSec: 20, workers: 2, ...r });
    }
    return out;
  },
};

const main = async () => {
  const selected = args.only ? args.only.split(',') : Object.keys(scenarios);
  const results = {
    date: new Date().toISOString(),
    machine: {
      cpu: os.cpus()[0].model,
      threads: os.cpus().length,
      memoryGb: Math.round(os.totalmem() / 1024 ** 3),
      os: `${os.type()} ${os.release()}`,
      node: process.version,
    },
    limits: composeLimits(),
    workload: { handler: 'demo', handlerWorkMs: WORK_MS, trials: Number(args.trials) },
    scenarios: {},
  };

  for (const name of selected) {
    log(`\n== ${name}`);
    results.scenarios[name] = await scenarios[name](results);
  }

  fs.mkdirSync(args.out, { recursive: true });
  const file = path.join(args.out, `results-${results.date.slice(0, 19).replace(/:/g, '-')}.json`);
  fs.writeFileSync(file, `${JSON.stringify(results, null, 2)}\n`);
  log(`\nSaved ${file}`);

  await db.pool.end();
  await closeRedis();
};

main().catch(async (err) => {
  console.error(err);
  process.exit(1);
});
