process.env.LOG_LEVEL = 'silent';
const test = require('node:test');
const assert = require('node:assert/strict');
const { computeBackoff } = require('../src/backoff');
const { partitionFor, keysForJob, allStreams } = require('../src/keys');
const { validateJob, validateSchedule } = require('../src/validation');
const { nextRun } = require('../src/cron');
const { compareIds, parseMessage } = require('../src/queue-manager');

test('backoff grows exponentially, stays within [exp/2, exp] and is capped', () => {
  const opts = { baseMs: 1000, maxMs: 10000 };
  assert.equal(computeBackoff(1, opts, () => 0), 500);
  assert.equal(computeBackoff(1, opts, () => 1), 1000);
  assert.equal(computeBackoff(3, opts, () => 1), 4000);
  assert.equal(computeBackoff(10, opts, () => 1), 10000);
  assert.equal(computeBackoff(10, opts, () => 0), 5000);
});

test('partitioning is deterministic and spreads keys', () => {
  const id = '3f1e9a52-0000-4000-8000-000000000001';
  assert.equal(partitionFor(id, 4), partitionFor(id, 4));
  const seen = new Set();
  for (let i = 0; i < 200; i++) seen.add(partitionFor(`job-${i}`, 4));
  assert.equal(seen.size, 4);
});

test('stream, delayed set and DLQ share a Redis Cluster hash tag', () => {
  const k = keysForJob({ id: 'abc', queue: 'default', priority: 'high' }, { partitions: 4, prefix: 'p' });
  const tag = (key) => key.match(/\{(.+)\}/)[1];
  assert.equal(tag(k.stream), tag(k.delayed));
  assert.equal(tag(k.stream), tag(k.dlq));
});

test('allStreams orders lanes high -> normal -> low', () => {
  const streams = allStreams({ queues: ['a', 'b'], partitions: 2, prefix: 'p' });
  assert.equal(streams.length, 12);
  assert.deepEqual([...new Set(streams.map((s) => s.lane))], ['high', 'normal', 'low']);
});

test('validateJob applies defaults and rejects bad input', () => {
  const spec = validateJob({ type: 'email', payload: { to: 'x' } });
  assert.equal(spec.queue, 'default');
  assert.equal(spec.priority, 'normal');
  assert.equal(spec.maxAttempts, 4);
  assert.equal(spec.runAt, undefined);

  assert.throws(() => validateJob({}), /type/);
  assert.throws(() => validateJob({ type: 'a b' }), /type/);
  assert.throws(() => validateJob({ type: 'x', payload: [] }), /payload/);
  assert.throws(() => validateJob({ type: 'x', queue: 'nope' }), /queue/);
  assert.throws(() => validateJob({ type: 'x', priority: 'urgent' }), /priority/);
  assert.throws(() => validateJob({ type: 'x', maxAttempts: 0 }), /maxAttempts/);
  assert.throws(() => validateJob({ type: 'x', runAt: 'yesterday' }), /runAt/);
  assert.throws(() => validateJob({ type: 'x', runAt: '2030-01-01T00:00:00Z', delayMs: 5 }), /either/);
});

test('validateJob handles delays and idempotency keys', () => {
  const before = Date.now();
  const spec = validateJob({ type: 'x', delayMs: 5000 }, { idempotencyKey: 'abc' });
  assert.ok(spec.runAt.getTime() >= before + 5000);
  assert.equal(spec.idempotencyKey, 'abc');
  assert.throws(() => validateJob({ type: 'x' }, { idempotencyKey: '' }), /idempotencyKey/);
});

test('validateSchedule requires name and cron', () => {
  assert.throws(() => validateSchedule({ type: 'x', cron: '* * * * *' }), /name/);
  assert.throws(() => validateSchedule({ type: 'x', name: 'n' }), /cron/);
  assert.equal(validateSchedule({ type: 'x', name: 'n', cron: '* * * * *' }).timezone, 'UTC');
});

test('cron next run honours timezone', () => {
  const after = new Date('2026-01-01T00:00:00Z');
  assert.equal(nextRun('*/15 * * * *', 'UTC', after).toISOString(), '2026-01-01T00:15:00.000Z');
  // 09:00 in India (UTC+5:30) is 03:30 UTC
  assert.equal(nextRun('0 9 * * *', 'Asia/Kolkata', after).toISOString(), '2026-01-01T03:30:00.000Z');
  assert.throws(() => nextRun('not a cron'));
});

test('stream IDs compare numerically, not lexically', () => {
  assert.equal(compareIds('9-0', '10-0'), -1);
  assert.equal(compareIds('10-2', '10-10'), -1);
  assert.equal(compareIds('5-5', '5-5'), 0);
});

test('parseMessage flattens stream fields', () => {
  assert.deepEqual(parseMessage(['1-0', ['jobId', 'a', 'enq', '5']]), { id: '1-0', jobId: 'a', enq: '5' });
});

test('rate limiter gives up on a hung Redis instead of blocking the request', async () => {
  const { consume } = require('../src/rate-limiter');
  const hung = { tokenBucket: () => new Promise(() => {}) };
  const started = Date.now();
  await assert.rejects(consume('k', { redis: hung, timeoutMs: 50 }), /timed out/);
  assert.ok(Date.now() - started < 1000);
});

test('Waker: wake() cuts a sleep short, an early wake() is not lost, stop ends sleep', async () => {
  const Waker = require('../src/waker');
  const ctrl = new AbortController();
  const w = new Waker(ctrl.signal);

  let t = Date.now();
  setTimeout(() => w.wake(), 20);
  assert.equal(await w.sleep(5000), true);
  assert.ok(Date.now() - t < 1000);

  w.wake(); // arrives while not sleeping
  assert.equal(await w.sleep(5000), true);

  assert.equal(await w.sleep(20), false); // plain timeout

  t = Date.now();
  setTimeout(() => ctrl.abort(), 20);
  assert.equal(await w.sleep(5000), false);
  assert.ok(Date.now() - t < 1000);
});
