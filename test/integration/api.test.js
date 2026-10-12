process.env.RATE_LIMIT_CAPACITY = '5';
process.env.RATE_LIMIT_REFILL_PER_SEC = '1';
const test = require('node:test');
const assert = require('node:assert/strict');
const { core, setup, reset, teardown } = require('./helpers');
const createApp = require('../../apps/api/src/app');
const Backpressure = require('../../apps/api/src/backpressure');

let server;
let base;
let backpressure;
const KEY = 'secret-key';

const call = async (method, path, body, headers = {}) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-api-key': KEY, ...headers },
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
};

test.before(async () => {
  await setup();
  const queueManager = new core.QueueManager();
  backpressure = new Backpressure({ queueManager, maxBacklog: 1000 });
  const app = createApp({ queueManager, backpressure, apiKeys: [KEY] });
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.beforeEach(reset);
test.after(async () => {
  server.close();
  await teardown();
});

test('rejects missing or wrong API key, health endpoints stay open', async () => {
  assert.equal((await call('GET', '/jobs', undefined, { 'x-api-key': '' })).status, 401);
  assert.equal((await call('GET', '/jobs', undefined, { 'x-api-key': 'wrong' })).status, 401);
  assert.equal((await call('GET', '/jobs', undefined, { 'x-api-key': '', authorization: `Bearer ${KEY}` })).status, 200);
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  assert.equal((await fetch(`${base}/readyz`)).status, 200);
  assert.match(await (await fetch(`${base}/metrics`)).text(), /http_requests_total/);
});

test('create, fetch, list with cursor pagination', async () => {
  const created = [];
  for (let i = 0; i < 3; i++) {
    const r = await call('POST', '/jobs', { type: 'demo', payload: { i } });
    assert.equal(r.status, 201);
    assert.equal(r.body.status, 'QUEUED');
    created.push(r.body.id);
  }
  assert.equal((await call('GET', `/jobs/${created[0]}`)).body.payload.i, 0);

  const page1 = await call('GET', '/jobs?limit=2');
  assert.equal(page1.body.jobs.length, 2);
  assert.ok(page1.body.nextCursor);
  const page2 = await call('GET', `/jobs?limit=2&cursor=${page1.body.nextCursor}`);
  assert.equal(page2.body.jobs.length, 1);
  assert.equal(page2.body.nextCursor, null);
  const all = [...page1.body.jobs, ...page2.body.jobs].map((j) => j.id).sort();
  assert.deepEqual(all, [...created].sort());
});

test('validation and error status codes', async () => {
  assert.equal((await call('POST', '/jobs', { payload: {} })).status, 400);
  assert.equal((await call('POST', '/jobs', '{not json')).status, 400);
  assert.equal((await call('POST', '/jobs', { type: 'x', payload: { big: 'a'.repeat(300 * 1024) } })).status, 413);
  assert.equal((await call('GET', '/jobs/not-a-uuid')).status, 404);
  assert.equal((await call('GET', '/jobs/00000000-0000-4000-8000-000000000000')).status, 404);
  assert.equal((await call('GET', '/jobs?status=WHATEVER')).status, 400);
  assert.equal((await call('GET', '/nope')).status, 404);
});

test('idempotency key header: second request returns 200 with the same job', async () => {
  const a = await call('POST', '/jobs', { type: 'demo' }, { 'idempotency-key': 'abc' });
  const b = await call('POST', '/jobs', { type: 'demo' }, { 'idempotency-key': 'abc' });
  assert.equal(a.status, 201);
  assert.equal(b.status, 200);
  assert.equal(a.body.id, b.body.id);
});

test('cancel and replay return 409 for invalid transitions', async () => {
  const { body: job } = await call('POST', '/jobs', { type: 'demo', delayMs: 60000 });
  assert.equal(job.status, 'SCHEDULED');
  assert.equal((await call('POST', `/jobs/${job.id}/replay`)).status, 409);
  assert.equal((await call('POST', `/jobs/${job.id}/cancel`)).body.status, 'CANCELLED');
  assert.equal((await call('POST', `/jobs/${job.id}/cancel`)).status, 409);
  assert.equal((await call('POST', `/jobs/${job.id}/replay`)).body.status, 'QUEUED');
});

test('batch create is all-or-nothing', async () => {
  const bad = await call('POST', '/jobs/batch', { jobs: [{ type: 'demo' }, { type: 'bad type' }] });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /jobs\[1\]/);
  assert.equal((await core.jobs.listJobs()).jobs.length, 0);

  const ok = await call('POST', '/jobs/batch', { jobs: [{ type: 'demo' }, { type: 'demo', priority: 'high' }] });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.jobs.length, 2);
});

test('schedules CRUD', async () => {
  assert.equal((await call('PUT', '/schedules/nightly', { cron: 'bad', type: 'demo' })).status, 400);
  const s = await call('PUT', '/schedules/nightly', { cron: '0 2 * * *', timezone: 'Asia/Kolkata', type: 'demo' });
  assert.equal(s.status, 200);
  assert.ok(new Date(s.body.nextRunAt) > new Date());
  assert.equal((await call('GET', '/schedules')).body.schedules.length, 1);
  assert.equal((await call('DELETE', '/schedules/nightly')).status, 204);
  assert.equal((await call('DELETE', '/schedules/nightly')).status, 404);
});

test('backpressure returns 429 when the queue backlog is over the limit', async () => {
  backpressure.backlog = { default: 5000 };
  const r = await call('POST', '/jobs', { type: 'demo' }, { 'x-api-key': KEY });
  assert.equal(r.status, 429);
  assert.equal(r.headers.get('retry-after'), '5');
  assert.equal((await call('POST', '/jobs', { type: 'demo', queue: 'analytics' })).status, 201);
  backpressure.backlog = {};
});

test('rate limit: token bucket shared through Redis returns 429', async () => {
  const statuses = [];
  for (let i = 0; i < 8; i++) statuses.push((await call('POST', '/jobs', { type: 'demo' })).status);
  assert.ok(statuses.includes(429), statuses.join(','));
  assert.ok(statuses.filter((s) => s === 201).length <= 6);
});

test('GET /queues and DLQ replay', async () => {
  const { body: job } = await call('POST', '/jobs', { type: 'demo' });
  await core.db.pool.query("UPDATE jobs SET status = 'DEAD' WHERE id = $1", [job.id]);
  await core.db.pool.query('DELETE FROM outbox');
  const q = await call('GET', '/queues');
  assert.equal(q.body.queues.default.jobs.DEAD, 1);
  const r = await call('POST', '/dlq/replay', { queue: 'default' });
  assert.deepEqual(r.body, { replayed: 1, jobIds: [job.id] });
  assert.equal((await core.jobs.getJob(job.id)).status, 'QUEUED');
});
