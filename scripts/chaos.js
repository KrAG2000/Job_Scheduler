#!/usr/bin/env node
// Chaos test: runs real worker + scheduler processes, SIGKILLs random workers (and
// optionally restarts Redis) while jobs are running, then verifies no job was lost.
//
//   node scripts/chaos.js --jobs 2000 --workers 4 --kill-every 2
//   node scripts/chaos.js --redis-container jstest-redis-1   # also restart Redis mid-run
//
// Needs Redis + Postgres (same env vars as the services).
const { parseArgs } = require('util');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const { values: args } = parseArgs({
  options: {
    jobs: { type: 'string', default: '2000' },
    workers: { type: 'string', default: '4' },
    'kill-every': { type: 'string', default: '2' },
    'redis-container': { type: 'string' },
    timeout: { type: 'string', default: '300' },
  },
});

// Short leases so crashed workers' jobs are recovered quickly during the test.
const childEnv = {
  ...process.env,
  LOG_LEVEL: 'warn',
  VISIBILITY_TIMEOUT_MS: '3000',
  HEARTBEAT_MS: '1000',
  RECLAIM_INTERVAL_MS: '1000',
  STUCK_AFTER_MS: '20000',
  SWEEP_INTERVAL_MS: '5000',
  RETRY_BASE_MS: '200',
  WORKER_CONCURRENCY: '10',
};
process.env.LOG_LEVEL = 'silent';
const { db, jobs, validateJob, closeRedis } = require('@scheduler/core');

const root = path.join(__dirname, '..');
let metricsPort = 9300;
const spawnService = (rel, name) => {
  const child = spawn(process.execPath, [path.join(root, rel)], {
    env: { ...childEnv, METRICS_PORT: String(metricsPort++), SERVICE_NAME: name },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  return child;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const main = async () => {
  const total = parseInt(args.jobs, 10);
  await db.migrate();
  await db.pool.query(`CREATE TABLE IF NOT EXISTS demo_executions (
    id BIGSERIAL PRIMARY KEY, job_id UUID NOT NULL, attempt INT NOT NULL, worker TEXT,
    at TIMESTAMPTZ NOT NULL DEFAULT now())`);

  const scheduler = spawnService('apps/scheduler/src/scheduler.js', 'scheduler');
  let workers = Array.from({ length: Number(args.workers) }, () => spawnService('apps/worker/src/worker.js', 'worker'));
  await sleep(1500);

  const runId = `chaos-${Date.now()}`;
  const specs = Array.from({ length: total }, () => validateJob({
    type: 'demo',
    payload: { durationMs: 50 + Math.floor(Math.random() * 450), record: true, runId },
  }));
  for (let i = 0; i < specs.length; i += 500) await jobs.createJobs(specs.slice(i, i + 500));
  console.log(`Enqueued ${total} jobs (run ${runId}); killing a worker every ${args['kill-every']}s`);

  let kills = 0;
  let redisRestarted = false;
  const killer = setInterval(() => {
    const victim = workers[Math.floor(Math.random() * workers.length)];
    victim.kill('SIGKILL');
    kills++;
    workers = workers.filter((w) => w !== victim);
    workers.push(spawnService('apps/worker/src/worker.js', 'worker'));
  }, Number(args['kill-every']) * 1000);

  const counts = async () => {
    const { rows } = await db.pool.query(
      `SELECT status, count(*)::int AS n FROM jobs WHERE payload->>'runId' = $1 GROUP BY status`, [runId],
    );
    return Object.fromEntries(rows.map((r) => [r.status, r.n]));
  };

  const started = Date.now();
  const deadline = started + Number(args.timeout) * 1000;
  let c = {};
  while (Date.now() < deadline) {
    c = await counts();
    const finished = (c.SUCCEEDED || 0) + (c.DEAD || 0);
    process.stdout.write(`\r  ${JSON.stringify(c)}  kills=${kills}      `);
    if (args['redis-container'] && !redisRestarted && finished > total / 3) {
      redisRestarted = true;
      console.log(`\n  restarting Redis container ${args['redis-container']}...`);
      execFileSync('docker', ['restart', args['redis-container']]);
    }
    if (finished >= total) break;
    // Stop killing once 90% are done so the tail can drain.
    if (finished > total * 0.9) clearInterval(killer);
    await sleep(500);
  }
  clearInterval(killer);

  const { rows: [dup] } = await db.pool.query(
    `SELECT count(*)::int AS executions, count(DISTINCT e.job_id)::int AS jobs,
            count(*) FILTER (WHERE e.attempt > 1)::int AS re_executions
     FROM demo_executions e JOIN jobs j ON j.id = e.job_id WHERE j.payload->>'runId' = $1`, [runId],
  );
  const succeeded = c.SUCCEEDED || 0;
  console.log(`\n\nResult after ${((Date.now() - started) / 1000).toFixed(1)}s, ${kills} worker kills${redisRestarted ? ', 1 Redis restart' : ''}:`);
  console.log(`  succeeded         : ${succeeded}/${total}`);
  console.log(`  lost / unfinished : ${total - succeeded}`);
  console.log(`  executions        : ${dup.executions} for ${dup.jobs} jobs (${dup.re_executions} re-runs after a crash: at-least-once)`);

  for (const w of workers) w.kill('SIGTERM');
  scheduler.kill('SIGTERM');
  await sleep(500);
  await db.pool.end();
  await closeRedis();
  if (succeeded !== total) {
    console.error('FAIL: some jobs did not complete');
    process.exit(1);
  }
  console.log('PASS: every job completed despite crashes');
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
