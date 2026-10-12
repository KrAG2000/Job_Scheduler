# Distributed Job Scheduler

A distributed job scheduler built with **Node.js**, **Redis Streams** and **PostgreSQL**. It runs immediate, delayed and cron jobs across any number of workers with at-least-once delivery, and survives worker crashes and Redis failover without losing jobs.

## Features

| Area | What you get |
|---|---|
| Scheduling | Immediate jobs, delayed jobs (`delayMs` / `runAt`), cron schedules with time zones |
| Delivery | At-least-once delivery, visibility timeout with heartbeats, automatic reclaim of crashed workers' jobs, fencing tokens against stale workers |
| Retries | Exponential backoff with jitter, per-job `maxAttempts`, non-retryable errors, dead letter queue with single and bulk replay |
| Routing | Named queues, three priority lanes (`high` / `normal` / `low`) with strict priority, hash-partitioned streams |
| Control | Per-job timeouts, cancellation (including running jobs), idempotency keys, all-or-nothing batch enqueue |
| Protection | API-key auth, distributed token-bucket rate limiting, queue-depth backpressure (429), payload size limits |
| Operations | Prometheus metrics, Grafana dashboard, structured JSON logs, health/readiness checks, graceful shutdown |
| HA | Stateless API, worker and scheduler replicas; Redis Sentinel overlay; Postgres as the source of truth |

## Architecture

```
            ┌──────────── nginx gateway ────────────┐
            │                                       │
       ┌────▼────┐ ×N                        ┌──────▼──────┐
       │   API   │                           │ tracker-api │
       └────┬────┘                           └──────┬──────┘
            │  INSERT job + outbox row (one transaction)
            ▼                                       ▼
   ┌──────────────────────── PostgreSQL ─────────────────────────┐
   │ jobs (source of truth)   outbox   cron_schedules            │
   └──────▲─────────────────────┬──────────────▲─────────────────┘
          │                     │ relay         │ cron / sweeper
          │              ┌──────▼──────┐ ×N     │
          │              │  scheduler  ├────────┘
          │              └──────┬──────┘
          │                     │ XADD jobId
          │      ┌──────────────▼───────────────────────────┐
          │      │ Redis: sched:{queue:lane:partition}       │
          │      │   :stream  (consumer group "workers")     │
          │      │   :delayed (ZSET, retry backoff)          │
          │      │   :dlq     (dead letters)                 │
          │      └──────────────┬───────────────────────────┘
          │                     │ XREADGROUP / XAUTOCLAIM
          │              ┌──────▼──────┐ ×N
          └──────────────┤   worker    │ status, result, fencing
                         └─────────────┘
```

| Service | Role | Scale |
|---|---|---|
| `apps/api` | REST API: create, list, cancel and replay jobs; manage cron schedules; queue stats | Stateless, any number behind nginx |
| `apps/worker` | Runs job handlers (`apps/worker/src/handlers`), heartbeats, reclaims and promotes retries | Any number; consumer group splits the work |
| `apps/scheduler` | Outbox relay, cron firing, stuck-job sweeper, stream trimming | Any number; coordinates with `FOR UPDATE SKIP LOCKED` |
| `apps/tracker-api` | Analytics ingestion; events go through the same durable job pipeline | Stateless |
| `packages/core` | Shared library: config, DB and migrations, Lua scripts, `Worker`, `Scheduler`, `QueueManager` | n/a |

### Job lifecycle

```
SCHEDULED ──(runAt reached)──► QUEUED ──► RUNNING ──► SUCCEEDED
                                 ▲           │
                                 │           ├─ error, attempts left ──► RETRYING ──(backoff)──┐
                                 └───────────┼─────────────────────────────────────────────────┘
                                             └─ no attempts left / NonRetryableError ──► DEAD
any non-terminal state ──(cancel)──► CANCELLED          DEAD / CANCELLED ──(replay)──► QUEUED
```

## How correctness is achieved

**Postgres is the source of truth; Redis only carries job IDs.** A stream message holds just `jobId`; the payload and state live in the `jobs` table (the claim-check pattern). Losing Redis data can delay jobs but cannot lose them.

1. **Transactional outbox.** `POST /jobs` inserts the job row and an `outbox` row in one transaction. Nothing is written to Redis on the request path, so a job is never half-created. The scheduler's relay locks a batch of outbox rows (`FOR UPDATE SKIP LOCKED`), `XADD`s them and deletes them in the same transaction. If Redis fails, the transaction rolls back and the rows are retried. Future-dated jobs are outbox rows that aren't "available" yet.
2. **Visibility timeout + heartbeats.** A message stays in the consumer group's pending list until its outcome is recorded. While a handler runs, the worker heartbeats: a Lua script resets the message's idle time, but only if this worker still owns it. If a worker dies, another one takes the message over with `XAUTOCLAIM` once it has been idle longer than `VISIBILITY_TIMEOUT_MS`.
3. **Fencing tokens.** Starting an attempt is a conditional `UPDATE ... SET attempts = attempts + 1`. That attempt number is a fencing token: every later write includes `WHERE attempts = <token> AND status = 'RUNNING'`. A worker that was paused or partitioned and lost its lease can't overwrite the result of the attempt that replaced it, and it won't ack a message it no longer owns.
4. **Idempotent consumption.** Duplicate deliveries (relay retries, sweeper re-publishes) are skipped because the start `UPDATE` only matches runnable states. Handlers still need idempotent side effects for the crash-mid-handler case; the analytics handler uses the job ID as the row's primary key with `ON CONFLICT DO NOTHING`.
5. **Atomic Redis transitions (Lua).** Scheduling a retry with `ZADD` and acking with `XACK` happen in one script, and so do moving a job to the DLQ and acking it. Promoting due retries reads and removes them atomically, so any number of workers can run the promoter without enqueueing a job twice.
6. **Sweeper.** Postgres knows every job that should be making progress. Jobs stuck in `QUEUED`/`RETRYING`/`RUNNING` longer than `STUCK_AFTER_MS` are put back in the outbox. This covers Redis data loss: AOF fsync window, async replication during failover, or an accidental flush.
7. **Exactly one job per cron tick.** The schedule row is locked while it fires, and the job's idempotency key is `cron:<name>:<tick>`. Several scheduler replicas share the work without leader election.
8. **Poison messages.** Every delivery, including reclaims after crashes, consumes an attempt. A job that crashes its worker every time still ends up `DEAD` instead of looping forever.
9. **Safe stream trimming.** `XACK` doesn't delete entries, so the scheduler trims each stream with `XTRIM MINID`, strictly below both the group's last-delivered ID and the oldest pending ID. `MAXLEN` trimming could drop entries that were never delivered.

Delivery is **at-least-once**. Exactly-once *effects* need idempotent handlers. Every handler receives the stable `job.id` to use as an idempotency key with downstream systems.

## Quick start

```bash
npm install

# Option A: full stack in Docker (2 APIs behind nginx, 3 workers, 2 schedulers,
# tracker, Prometheus, Grafana)
docker compose up -d --build
#   API + tracker gateway: http://localhost:8000
#   Grafana:               http://localhost:3030  (dashboard "Job Scheduler")
#   Prometheus:            http://localhost:9090

# Option B: infra in Docker, services on the host
docker compose up -d redis postgres
npm start                 # api + worker + scheduler
npm run start:tracker     # optional
```

Host ports are configurable if they clash: `REDIS_HOST_PORT`, `PG_HOST_PORT`, `GATEWAY_PORT`, `GRAFANA_PORT`, `PROMETHEUS_PORT`. Scale with `docker compose up -d --scale worker=6`.

Redis HA (primary, replica and 3 Sentinels):

```bash
docker compose -f docker-compose.yml -f docker-compose.ha.yml up -d --build
```

## API

Set `API_KEYS=key1,key2` to enable auth (`x-api-key: key1` or `Authorization: Bearer key1`). Without it, auth is disabled and a warning is logged.

```bash
# Immediate job (Idempotency-Key makes client retries safe: same key -> same job, 200)
curl -X POST localhost:8000/jobs -H 'content-type: application/json' -H 'Idempotency-Key: order-42' \
  -d '{"type":"email","payload":{"to":"a@b.com"},"priority":"high","maxAttempts":5,"timeoutMs":10000}'

# Delayed / scheduled
curl -X POST localhost:8000/jobs -H 'content-type: application/json' \
  -d '{"type":"email","payload":{"to":"a@b.com"},"delayMs":60000}'
curl -X POST localhost:8000/jobs -H 'content-type: application/json' \
  -d '{"type":"email","payload":{"to":"a@b.com"},"runAt":"2030-01-01T09:00:00Z"}'

# Batch (up to 500, one transaction)
curl -X POST localhost:8000/jobs/batch -H 'content-type: application/json' \
  -d '{"jobs":[{"type":"demo"},{"type":"demo","queue":"analytics"}]}'

curl localhost:8000/jobs/<id>
curl 'localhost:8000/jobs?status=DEAD&queue=default&limit=50'   # keyset pagination: &cursor=<nextCursor>
curl -X POST localhost:8000/jobs/<id>/cancel
curl -X POST localhost:8000/jobs/<id>/replay                     # DEAD or CANCELLED only
curl -X POST localhost:8000/dlq/replay -H 'content-type: application/json' -d '{"queue":"default","limit":100}'

# Cron (6-field expressions with seconds are supported too)
curl -X PUT localhost:8000/schedules/nightly-report -H 'content-type: application/json' \
  -d '{"cron":"0 2 * * *","timezone":"Asia/Kolkata","type":"email","payload":{"to":"ops@x.com"}}'
curl localhost:8000/schedules
curl -X DELETE localhost:8000/schedules/nightly-report

curl localhost:8000/queues     # lag / pending / delayed / dlq per queue + job counts by status
curl localhost:8000/healthz    # liveness
curl localhost:8000/readyz     # Postgres + Redis reachable
```

| Field | Default | Notes |
|---|---|---|
| `type` | required | Must match a registered handler, otherwise the job is dead-lettered |
| `payload` | `{}` | JSON object |
| `queue` | `default` | One of `QUEUES` (default `default,analytics`) |
| `priority` | `normal` | `high`, `normal`, `low` |
| `maxAttempts` | 4 | Total attempts, including the first |
| `timeoutMs` | 30000 | Handler is aborted and the attempt fails after this |
| `delayMs` / `runAt` | now | One or the other |
| `idempotencyKey` | none | Or the `Idempotency-Key` header |

Responses: `201` created, `200` idempotent replay, `400` validation, `401` auth, `404`, `409` invalid state transition, `413` payload too large, `429` rate limited or queue overloaded (with `Retry-After`).

### Writing a handler

```js
// apps/worker/src/handlers/index.js
module.exports = {
  'invoice.generate': async (job, ctx) => {
    // job: { id, type, queue, priority, payload, attempt, maxAttempts, createdAt }
    // ctx: { signal, log, jobId, attempt, maxAttempts }
    if (!job.payload.customerId) throw new NonRetryableError('customerId missing'); // straight to DLQ
    const pdf = await render(job.payload, { signal: ctx.signal }); // honour ctx.signal (timeout/cancel)
    await storage.put(`invoices/${job.id}.pdf`, pdf);              // job.id as idempotency key
    return { key: `invoices/${job.id}.pdf` };                      // stored in jobs.result
  },
};
```

### Analytics tracker

```bash
node scripts/create-site.js example.com        # prints an API key
```
```html
<script src="tracker.js"></script>
<script>SchedulerTracker.init({ apiKey: 'site_...', endpoint: 'http://localhost:8000/track' });</script>
```

## Testing

```bash
npm test                         # unit tests, no infrastructure needed
docker compose up -d redis postgres
npm run test:integration         # real Redis + Postgres (uses database scheduler_test)
```

The integration suite reproduces each failure mode: `kill -9` of a worker mid-job, a stale worker after losing its lease (fencing), duplicate deliveries, concurrent promoters, concurrent relays, Redis failing during relay, three schedulers racing on one cron tick, Redis data loss (sweeper), safe trimming and poison messages. It also covers the API's auth, validation, rate limiting, backpressure, pagination and state-transition rules.

### Chaos test

```bash
npm run chaos -- --jobs 2000 --workers 4 --kill-every 2
npm run chaos -- --redis-container <redis container name>    # also restarts Redis mid-run
```

Runs real worker and scheduler processes, `SIGKILL`s a random worker every N seconds, then checks that every job finished. Sample run: 1,500 jobs, 4 worker kills and 1 Redis restart. 1,500/1,500 succeeded, 0 lost, 38 jobs re-executed after crashes (at-least-once).

### Load test

```bash
npm run load -- --url http://localhost:8000 --jobs 30000 --concurrency 20 --batch 100 --work-ms 10
```

Measured on one 16-core dev machine, everything in Docker (2 APIs, 2 schedulers, worker concurrency 20, 10 ms jobs, rate limit raised):

| Scenario | Ingest | End-to-end |
|---|---|---|
| 5,000 single-job requests, 50 clients, 3 workers | 606 jobs/s (p50 76 ms, p99 264 ms) | 570 jobs/s |
| 30,000 jobs in batches of 100, 3 workers | 6,959 jobs/s | 1,495 jobs/s |
| Same, 6 workers | 3,482 jobs/s | 2,208 jobs/s |
| 20,000 jobs, Redis primary killed mid-run (Sentinel overlay) | 2,385 jobs/s, all 201 | all completed after a ~6–8 s failover, 0 lost |

**The bottleneck is Postgres.** It runs at about 6 cores while Redis is nearly idle, because each job costs about 4 Postgres writes (insert, outbox, start, finish). Doubling workers gave +48%, not +100%. Next steps would be batching the status writes, partitioning the `jobs` table, or moving high-volume, low-value jobs (such as analytics) to a lighter path.

## Configuration

All settings are environment variables (see `packages/core/src/config.js`). The main ones:

| Variable | Default | |
|---|---|---|
| `QUEUES` | `default,analytics` | Queue names (all services must agree) |
| `QUEUE_PARTITIONS` | 4 | Streams per queue and lane |
| `WORKER_QUEUES` | all | Queues this worker consumes |
| `WORKER_CONCURRENCY` | 10 | Jobs in flight per worker process |
| `VISIBILITY_TIMEOUT_MS` | 30000 | Idle time before a message is reclaimed |
| `HEARTBEAT_MS` | 10000 | Must be well below the visibility timeout |
| `JOB_MAX_ATTEMPTS` / `JOB_TIMEOUT_MS` | 4 / 30000 | Defaults per job |
| `RETRY_BASE_MS` / `RETRY_MAX_MS` | 1000 / 300000 | Backoff |
| `STUCK_AFTER_MS` | 600000 | Sweeper threshold |
| `API_KEYS` | none | Comma-separated; empty disables auth |
| `RATE_LIMIT_CAPACITY` / `RATE_LIMIT_REFILL_PER_SEC` | 200 / 100 | Token bucket per API key (or IP) |
| `MAX_QUEUE_BACKLOG` | 100000 | 429 above this queue depth |
| `REDIS_SENTINELS` / `REDIS_MASTER_NAME` | none / `mymaster` | Enables Sentinel mode |
| `DATABASE_URL` or `DB_*`, `REDIS_URL` or `REDIS_HOST`/`REDIS_PORT` | localhost | Connections |

## Design trade-offs and known limits

- **Strict priority can starve `low`** under sustained `high` load. Weighted fetching is the alternative.
- **Idle polling.** Workers poll streams non-blocking, backing off up to `POLL_MAX_MS` (250 ms) when idle, so one worker can serve many streams and stay Redis Cluster-safe. The cost is up to ~250 ms of extra latency on an idle system.
- **Partitions spread load; they don't order it.** Jobs within a partition run in parallel, and there is no per-key ordering guarantee.
- **Timeouts are cooperative.** JavaScript can't kill a running promise. A handler that ignores `ctx.signal` keeps running after its timeout, but its result is discarded.
- **Redis replication is async**, so a failover can lose recently written stream entries. The sweeper recovers them after `STUCK_AFTER_MS`, which delays those jobs.
- **Postgres is a single primary.** For HA, use a managed Postgres with a synchronous standby. For scale, partition `jobs` by time and archive finished jobs.
