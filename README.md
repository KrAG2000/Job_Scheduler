# High-Throughput Distributed Job Scheduler

A robust, distributed job scheduler built with **Node.js**, **Redis Streams**, and **PostgreSQL**. Designed to handle high concurrency, fault tolerance, and "at-least-once" delivery guarantees.

## 🚀 Key Features

- **Distributed Architecture**: Monorepo with separate API (Producer) and Worker (Consumer) services.
- **Redis Streams**: Uses Consumer Groups for horizontal scaling and message persistence.
- **Reliability**:
  - **At-Least-Once Delivery**: Jobs are acknowledged (`XACK`) only after successful processing.
  - **Exponential Backoff**: Failed jobs are moved to a ZSET and re-enqueued with increasing delays (2s, 4s, 8s).
  - **Dead Letter Queue (DLQ)**: Jobs failing max retries are moved to a separate `jobs_stream:dlq`.
- **Persistence**: Job status (PENDING, PROCESSING, COMPLETED, FAILED) is persisted in PostgreSQL for historical querying.
- **Scalability**: Spin up multiple `worker` instances to increase throughput.

## 🛠 Tech Stack

- **Runtime**: Node.js
- **Queue**: Redis (Streams + ZSET)
- **Database**: PostgreSQL
- **Containerization**: Docker & Docker Compose

## 📂 Project Structure

```
.
├── apps
│   ├── api          # Express server (Producer)
│   └── worker       # Job processor (Consumer)
├── packages
│   └── core         # Shared logic (Redis wrapper, Queue Manager, DB)
├── docker-compose.yml
└── load-test.js
```

## 🏁 Getting Started

### 1. Prerequisites
- Docker & Docker Compose
- Node.js (v18+)

### 2. Setup
```bash
# Install dependencies
npm install

# Start Infrastructure (Redis + Postgres)
docker-compose up -d
```

### 3. Run Services
You can run both API and Worker in one terminal:
```bash
npm start
```
Or separately:
```bash
npm run start:api
npm run start:worker
```

### 4. Submit a Job
```bash
curl -X POST http://localhost:3000/jobs \
  -H "Content-Type: application/json" \
  -d '{"type":"EMAIL", "payload":{"to":"test@example.com"}}'
```

### 5. Check Status
```bash
curl http://localhost:3000/jobs/<JOB_ID>
```

## 🧪 Testing

### Load Test
Run the included load test script to simulate 1000 concurrent jobs:
```bash
node load-test.js
```

### Chaos Test
1. Start the system.
2. Submit a long-running job.
3. Kill the worker process (`CTRL+C`) while it's processing.
4. Restart the worker.
5. Observe that the job is picked up again (after the visibility timeout or manual claim - *Note: This project implements immediate retry on failure, for stuck jobs a separate monitor would be added*).

## 🧠 System Design Concepts Demonstrated

1.  **Transactional Outbox (Simplified)**: We insert into Postgres *before* enqueueing to Redis to ensure we have a record of the job.
2.  **Consumer Groups**: Allows multiple workers to read from the same stream without processing the same message twice.
3.  **Idempotency**: The API generates a UUID. Workers should use this ID to ensure operations (like charging a credit card) aren't repeated if a job is retried.
4.  **Backpressure**: Redis Streams naturally handle backpressure; consumers pull data at their own pace.

---
*Built as a portfolio project to demonstrate advanced backend engineering skills.*
