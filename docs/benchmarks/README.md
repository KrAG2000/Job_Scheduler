# Benchmarks

Measured on 2026-10-12/13. Raw data for every run is in the JSON files in this folder.

## Method

- **Tooling:** `scripts/benchmark.js` (throughput and latency) and `scripts/chaos.js` (reliability).
- **System under test:** the full Docker Compose stack. That's 2 API replicas behind nginx, workers, a scheduler, Redis 7 and Postgres 15.
- **Workload:** the `demo` handler with 10 ms of simulated work per job.
- **Where the numbers come from:** Postgres timestamps (`created_at`, `started_at`, `finished_at`) for every job, not client-side estimates.
  - **Queue latency** is `started_at - created_at`: from the moment the job is durably committed until a worker starts it.
  - **End-to-end latency** is `finished_at - created_at`.
  - **Drain throughput** is the number of jobs divided by the time from the first start to the last finish.
- **Load:**
  - Ingest uses a closed loop: N clients, each waiting for its response before sending again.
  - Latency uses an open loop: a fixed arrival rate based on wall-clock time, so a slow system can't quietly lower its own load ("coordinated omission"). A run is flagged `saturated` if requests back up.
- **Trials:** each scenario ran 3 times, and the tables show the median. The first trial is usually the slowest (JIT and cache warm-up).
- **Durability:** fully on. `synchronous_commit` is on and Redis uses AOF with `appendfsync everysec`.
- **Hardware caveat:** everything, including the load generator, runs on one laptop, so the services compete for the same CPU. Real deployments on separate machines would do better. Treat these numbers as a lower bound and a comparison baseline.

Machine: Intel Core i7-13620H (16 threads), 15 GB RAM, Fedora (Linux 7.1), Docker 29.6, Node 20.19.

## Profile A: capped resources

`docker-compose.bench.yml` pins every container, so the result doesn't depend on what else the machine is doing. Total budget at 4 workers is about 5.5 vCPU.

| Service | CPU limit | Memory limit |
|---|---|---|
| Postgres | 1.5 | 768 MB |
| Redis | 0.5 | 256 MB |
| API (×2) | 0.5 each | 192 MB each |
| Worker (×1–4) | 0.5 each | 192 MB each |
| Scheduler (×1) | 0.5 | 192 MB |

| Scenario | Result (median of 3) |
|---|---|
| Ingest, 1 job/request, 32 clients | **250 jobs/s**, p50 113 ms, p99 302 ms |
| Ingest, 100 jobs/request, 8 clients | **539 jobs/s** |
| Drain, 1 / 2 / 4 workers | 325 / 432 / 500 jobs/s (1.0× / 1.33× / 1.54×) |
| Latency at 60 jobs/s (2 workers) | queue p50 **10 ms**, p99 38 ms; end-to-end p99 63 ms |
| Latency at 130 jobs/s | queue p50 13 ms, p99 78 ms; end-to-end p99 98 ms |
| Latency at 190 jobs/s | queue p50 18 ms, p99 109 ms; end-to-end p99 159 ms |

None of the latency runs were saturated, and every job succeeded. Scaling flattens because Postgres hits its 1.5 vCPU limit: each job costs about 4 Postgres writes. File: `results-2026-10-12T18-36-53.json`.

## Profile B: uncapped (whole laptop)

Same stack with no container limits, worker concurrency 32 and 2 schedulers.

| Scenario | Result (median of 3) |
|---|---|
| Ingest, 1 job/request, 64 clients | **864 jobs/s**, p50 69 ms, p99 184 ms |
| Ingest, 100 jobs/request, 16 clients | **3,963 jobs/s** |
| Drain, 1 / 2 / 4 / 8 workers | 727 / 1,199 / **2,871** / 2,869 jobs/s (4 workers = **3.95×** 1 worker) |
| Latency at ~90 jobs/s (4 workers) | queue p50 **16 ms**, p99 26 ms; end-to-end p99 45 ms |
| Latency at ~400 jobs/s | queue p50 17 ms, p99 42 ms; end-to-end p99 66 ms |
| Latency at ~720 jobs/s | queue p50 17 ms, p99 53 ms; end-to-end p99 77 ms |

Going from 4 to 8 workers adds nothing because Postgres saturates (about 6 cores busy). In this run the load generator undershot its target rates (bug since fixed), so the rates shown are the ones actually achieved: jobs sent divided by 30 s. File: `results-2026-10-12T17-58-44.json`.

## Optimisation history

Both runs below use the uncapped profile. The latency figures are at the ~90 jobs/s step.

| Version | Queue latency p50 / p99 | Ingest (1 job/request) | |
|---|---|---|---|
| Polling relay (200 ms) + polling workers (up to 250 ms) | 129 ms / 265 ms | 723 jobs/s | `baseline-polling-2026-10-12.json` |
| Wake-ups via Postgres `LISTEN/NOTIFY` | 17 ms / 34 ms | **200 jobs/s (−72%)** | `experiment-pg-notify-2026-10-12.json` |
| Wake-ups via coalesced Redis pub/sub (final) | **16 ms / 26 ms** | 864 jobs/s | `results-2026-10-12T17-58-44.json` |

- **Push wake-ups cut median scheduling latency about 8× and p99 about 10×.**
- **`NOTIFY` regressed ingest badly.** Every transaction that notifies takes a global lock at commit, which serialized job creation.
- **Final design:** the wake-up is sent as a hint over Redis after the commit (at most one per event-loop turn per process). Polling stays as a fallback, so a lost hint only costs latency, never correctness.

The baseline and NOTIFY rows are single runs, while the final row is the median of 3.

## Reliability

| Test | Result |
|---|---|
| Chaos: 3,000 jobs, 3 workers, a random worker `SIGKILL`ed every 2 s (5 kills) plus a Redis restart, capped Redis/Postgres | **3,000/3,000 completed, 0 lost**; 39 jobs (1.3%) ran twice (at-least-once) |
| Chaos: 2,000 jobs, 4 workers, 5 kills plus a Redis restart, uncapped | 2,000/2,000 completed, 0 lost; 48 jobs (2.4%) ran twice |
| Redis primary stopped mid-load (Sentinel overlay, 20,000 jobs) | API kept accepting jobs (all 201, because jobs go to Postgres first); Sentinel promoted the replica in about 6–8 s; **all 20,000 completed, 0 lost** (single run) |
| Integration suite | 43 tests covering crash recovery, fencing, duplicate delivery, cron races, relay failure, Redis data loss and poison messages |

## Reproduce

```bash
# Capped profile (about 5.5 vCPU, about 2.5 GB), no Prometheus/Grafana
export COMPOSE_FILE=docker-compose.yml:docker-compose.bench.yml
export RATE_LIMIT_CAPACITY=10000000 RATE_LIMIT_REFILL_PER_SEC=10000000 MAX_QUEUE_BACKLOG=10000000
docker compose up -d --build redis postgres api worker scheduler tracker-api gateway
COMPOSE_FILES=docker-compose.yml,docker-compose.bench.yml \
  node scripts/benchmark.js --reset-db --trials 3      # about 15 min; --reset-db TRUNCATEs jobs!
node scripts/chaos.js --jobs 3000 --workers 3 --kill-every 2 --redis-container <redis container>
docker compose down -v
```

The rate limit and backlog limits are raised for benchmarking only; otherwise the API's own protection would throttle the load generator.
