#!/usr/bin/env node
// Load test against the HTTP API (default: the nginx gateway from docker compose).
//
//   node scripts/load.js --jobs 20000 --concurrency 50 --batch 100 --work-ms 20
//
// Reports ingest throughput + request latency, then waits for every job to finish and
// reports end-to-end throughput (submit -> SUCCEEDED).
const { parseArgs } = require('util');

const { values: args } = parseArgs({
  options: {
    url: { type: 'string', default: process.env.BASE_URL || 'http://localhost:8000' },
    key: { type: 'string', default: process.env.API_KEY || '' },
    jobs: { type: 'string', default: '10000' },
    concurrency: { type: 'string', default: '50' },
    batch: { type: 'string', default: '1' },
    'work-ms': { type: 'string', default: '10' },
    'fail-rate': { type: 'string', default: '0' },
    timeout: { type: 'string', default: '600' },
  },
});

const total = parseInt(args.jobs, 10);
const concurrency = parseInt(args.concurrency, 10);
const batch = parseInt(args.batch, 10);
const job = () => ({ type: 'demo', payload: { durationMs: Number(args['work-ms']), failRate: Number(args['fail-rate']) } });
const headers = { 'content-type': 'application/json', ...(args.key ? { 'x-api-key': args.key } : {}) };

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];

const finishedCount = async () => {
  const res = await fetch(`${args.url}/queues`, { headers });
  if (!res.ok) throw new Error(`/queues -> ${res.status}`);
  const { queues } = await res.json();
  let n = 0;
  for (const q of Object.values(queues)) n += (q.jobs.SUCCEEDED || 0) + (q.jobs.DEAD || 0);
  return n;
};

const main = async () => {
  const baseline = await finishedCount();
  const latencies = [];
  const statuses = {};
  let submitted = 0;
  let next = 0;
  const requests = Math.ceil(total / batch);

  const t0 = performance.now();
  const clients = Array.from({ length: concurrency }, async () => {
    while (next < requests) {
      const i = next++;
      const size = Math.min(batch, total - i * batch);
      const body = batch === 1 ? job() : { jobs: Array.from({ length: size }, job) };
      const start = performance.now();
      for (;;) {
        const res = await fetch(`${args.url}/jobs${batch === 1 ? '' : '/batch'}`, {
          method: 'POST', headers, body: JSON.stringify(body),
        }).catch((err) => ({ status: `ERR ${err.cause?.code || err.message}`, text: async () => '' }));
        await res.text();
        statuses[res.status] = (statuses[res.status] || 0) + 1;
        if (res.status === 201 || res.status === 200) break;
        if (res.status !== 429 && !String(res.status).startsWith('5') && !String(res.status).startsWith('ERR')) {
          throw new Error(`unexpected status ${res.status}`);
        }
        await new Promise((r) => setTimeout(r, 200)); // back off on 429/5xx and retry
      }
      latencies.push(performance.now() - start);
      submitted += size;
    }
  });
  await Promise.all(clients);
  const ingestSec = (performance.now() - t0) / 1000;

  latencies.sort((a, b) => a - b);
  console.log(`\nSubmitted ${submitted} jobs in ${ingestSec.toFixed(2)}s (${args.batch}/request, ${concurrency} clients)`);
  console.log(`  ingest throughput : ${(submitted / ingestSec).toFixed(0)} jobs/s`);
  console.log(`  request latency   : p50 ${pct(latencies, 50).toFixed(1)}ms  p95 ${pct(latencies, 95).toFixed(1)}ms  p99 ${pct(latencies, 99).toFixed(1)}ms`);
  console.log(`  responses         : ${JSON.stringify(statuses)}`);

  const deadline = Date.now() + Number(args.timeout) * 1000;
  let done = 0;
  while (Date.now() < deadline) {
    try {
      done = (await finishedCount()) - baseline;
    } catch (err) {
      // e.g. Redis failing over: /queues is briefly unavailable, keep waiting.
      process.stdout.write(`\r  (stats unavailable: ${err.message})   `);
      await new Promise((r) => setTimeout(r, 1000));
      continue;
    }
    process.stdout.write(`\r  completed         : ${done}/${total}   `);
    if (done >= total) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  const e2eSec = (performance.now() - t0) / 1000;
  console.log(`\n  end-to-end        : ${done} jobs finished in ${e2eSec.toFixed(2)}s (${(done / e2eSec).toFixed(0)} jobs/s)\n`);
  if (done < total) process.exitCode = 1;
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
