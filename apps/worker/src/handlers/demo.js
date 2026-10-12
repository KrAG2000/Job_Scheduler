const { db, NonRetryableError } = require('@scheduler/core');

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason); }, { once: true });
});

/**
 * Configurable fake work for load and chaos testing.
 * payload: { durationMs, failRate, failTimes, fatal, record }
 *   failTimes: fail deterministically on the first N attempts
 *   fatal:     throw a non-retryable error (goes straight to the DLQ)
 *   record:    append a row to demo_executions so tests can count executions
 */
const demo = async (job, ctx) => {
  const { durationMs = 100, failRate = 0, failTimes = 0, fatal = false, record = false } = job.payload;

  if (record) {
    await db.pool.query(
      'INSERT INTO demo_executions (job_id, attempt, worker) VALUES ($1, $2, $3)',
      [job.id, job.attempt, process.pid],
    );
  }
  await sleep(durationMs, ctx.signal);

  if (fatal) throw new NonRetryableError('Fatal demo failure');
  if (job.attempt <= failTimes) throw new Error(`Planned failure on attempt ${job.attempt}`);
  if (Math.random() < failRate) throw new Error('Random simulated failure');

  return { ok: true, attempt: job.attempt };
};

module.exports = demo;
