# Job Scheduler Flowcharts For VS Code

This version avoids HTML labels like `<br/>`, which some VS Code Mermaid renderers display incorrectly as black squares.

If this still renders badly in your VS Code, open the file in:
- GitHub markdown preview
- Mermaid Live Editor
- Markdown preview in another editor

## 1. Monorepo Structure

```mermaid
flowchart TB
    A["Root Monorepo\npackage.json + npm workspaces"] --> B["apps/api\nMain job producer API"]
    A --> C["apps/worker\nMain consumer and processor"]
    A --> D["apps/tracker-api\nAnalytics ingestion producer"]
    A --> E["apps/tracker-script\nBrowser tracking client"]
    A --> F["packages/core\nShared Redis, DB, QueueManager"]
    A --> G["docker-compose.yml\nRedis and Postgres infra"]
    A --> H["scripts/load-test.sh\nSimple load generation"]

    F --> F1["redis-client.js"]
    F --> F2["db.js"]
    F --> F3["queue-manager.js"]
```

## 2. End-to-End Architecture

```mermaid
flowchart LR
    Client["Client or Caller"] --> API["Main API"]
    Browser["Tracked Browser"] --> TrackerScript["Tracker Script"]
    TrackerScript --> TrackerAPI["Tracker API"]

    API --> PG["PostgreSQL"]
    API --> RS["Redis Streams"]
    TrackerAPI --> RS

    Worker["Worker Process"] --> RS
    Worker --> PG

    RS --> Delayed["Redis Sorted Set for delayed retries"]
    Worker --> Delayed
    Delayed --> RS

    Worker --> DLQ["Dead Letter Queue stream"]
```

## 3. Main Job Happy Path

```mermaid
sequenceDiagram
    participant U as User
    participant A as API
    participant P as PostgreSQL
    participant R as Redis Stream
    participant W as Worker

    U->>A: POST /jobs
    A->>A: Validate input
    A->>A: Generate jobId
    A->>P: Insert job status = PENDING
    P-->>A: Success
    A->>R: XADD job message
    R-->>A: Return Redis message ID
    A->>P: Update row with redis_id
    P-->>A: Success
    A-->>U: 201 Created

    W->>R: XREADGROUP
    R-->>W: Deliver job
    W->>P: Update status = PROCESSING
    W->>W: Execute work
    W->>P: Update status = COMPLETED
    W->>R: XACK
```

## 4. Main API Decision Flow

```mermaid
flowchart TD
    A1["Incoming POST /jobs"] --> A2{"Has type and payload?"}
    A2 -- No --> A3["Return 400"]
    A2 -- Yes --> A4["Generate UUID jobId"]
    A4 --> A5["Insert row into jobs table with PENDING"]
    A5 --> A6{"Postgres insert succeeds?"}
    A6 -- No --> A7["Return 500"]
    A6 -- Yes --> A8["XADD to Redis stream"]
    A8 --> A9{"Redis enqueue succeeds?"}
    A9 -- No --> A10["DB row exists but no queued message"]
    A9 -- Yes --> A11["Update jobs.redis_id"]
    A11 --> A12{"DB update succeeds?"}
    A12 -- No --> A13["Job is queued but metadata is incomplete"]
    A12 -- Yes --> A14["Return 201 Created"]
```

## 5. Worker Consumption Flow

```mermaid
flowchart TD
    W1["Worker starts"] --> W2["Init DB and QueueManager"]
    W2 --> W3["Create or reuse consumer group"]
    W3 --> W4["Start delayed scheduler loop"]
    W4 --> W5["Loop forever"]
    W5 --> W6["XREADGROUP BLOCK 5000 COUNT 1"]
    W6 --> W7{"Message received?"}
    W7 -- No --> W5
    W7 -- Yes --> W8["Parse job payload"]
    W8 --> W9{"Analytics event job?"}
    W9 -- Yes --> W10["Insert into analytics_events"]
    W9 -- No --> W11["Update job to PROCESSING"]
    W10 --> W12["Success path"]
    W11 --> W13["Execute work"]
    W13 --> W14{"Failure?"}
    W14 -- No --> W15["Update job to COMPLETED"]
    W14 -- Yes --> W16["Update job to FAILED"]
    W15 --> W12
    W12 --> W17["XACK message"]
    W16 --> W18["Throw error to QueueManager"]
    W18 --> W19["Failure handler runs"]
```

## 6. Retry and DLQ Flow

```mermaid
sequenceDiagram
    participant W as Worker
    participant P as PostgreSQL
    participant R as Redis Stream
    participant Z as Delayed Retry ZSET
    participant D as DLQ Stream

    W->>P: Update job status = FAILED
    W->>W: Throw error upward
    W->>R: XACK original message
    W->>W: Check retryCount
    alt retries remaining
        W->>Z: ZADD delayed job
        Note over W,Z: Backoff is 2s, 4s, 8s
        W->>R: Later re-add job with XADD
    else retries exhausted
        W->>D: XADD to DLQ
    end
```

## 7. Delayed Scheduler Internals

```mermaid
flowchart TD
    S1["Each worker runs a 1 second scheduler loop"] --> S2["ZRANGEBYSCORE delayed set up to now"]
    S2 --> S3{"Any due jobs?"}
    S3 -- No --> S1
    S3 -- Yes --> S4["For each due job"]
    S4 --> S5["Parse payload"]
    S5 --> S6["XADD back to jobs_stream"]
    S6 --> S7["ZREM from delayed set"]
    S7 --> S1
```

## 8. Job State Machine

```mermaid
stateDiagram-v2
    [*] --> PENDING
    PENDING --> PROCESSING
    PROCESSING --> COMPLETED
    PROCESSING --> FAILED
    FAILED --> PENDING: retry happens
    FAILED --> DLQ: retries exhausted
```

## 9. Tracker and Analytics Flow

```mermaid
sequenceDiagram
    participant B as Browser
    participant T as Tracker Script
    participant A as Tracker API
    participant P as PostgreSQL
    participant R as Redis Stream
    participant W as Worker

    B->>T: Pageview or click event
    T->>A: POST /track with API key
    A->>A: Check local site cache
    alt cache miss
        A->>P: Lookup site by API key
        P-->>A: site_id
        A->>A: Cache api_key to site_id
    end
    A->>R: XADD analytics job
    A-->>B: 202 Accepted
    W->>R: Consume analytics job
    W->>P: Insert analytics_events row
    W->>R: XACK
```

## 10. Runtime Dependency Map

```mermaid
flowchart TB
    subgraph Runtime
        A["API Service"]
        B["Worker Service"]
        C["Tracker API"]
    end

    subgraph Shared
        D["scheduler core package"]
        D1["DB Pool"]
        D2["Redis Client"]
        D3["Queue Manager"]
    end

    subgraph Infra
        E["PostgreSQL 15"]
        F["Redis 7"]
    end

    A --> D
    B --> D
    C --> D

    D --> D1
    D --> D2
    D --> D3

    D1 --> E
    D2 --> F
    D3 --> F
```

## 11. Data Model

```mermaid
erDiagram
    JOBS {
        uuid id PK
        varchar redis_id
        varchar status
        jsonb payload
        jsonb result
        timestamp created_at
        timestamp updated_at
    }

    SITES {
        uuid id PK
        varchar domain
        varchar api_key
        timestamp created_at
    }

    ANALYTICS_EVENTS {
        uuid id PK
        uuid site_id FK
        varchar type
        jsonb data
        varchar ip_address
        text user_agent
        timestamp created_at
    }

    SITES ||--o{ ANALYTICS_EVENTS : owns
```

## 12. Bottlenecks By Layer

```mermaid
flowchart TD
    B1["API Layer"] --> B2["Validation is minimal"]
    B1 --> B3["Every request hits Postgres"]
    B1 --> B4["No rate limiting on main API"]

    B5["Queue Layer"] --> B6["COUNT 1 limits throughput"]
    B5 --> B7["No pending message recovery"]
    B5 --> B8["Retry path is not atomic"]
    B5 --> B9["One shared stream for mixed workloads"]

    B10["Worker Layer"] --> B11["Serial processing per worker"]
    B10 --> B12["Many DB updates"]
    B10 --> B13["Demo failure logic only"]

    B14["Storage Layer"] --> B15["Missing useful indexes"]
    B14 --> B16["Analytics writes can grow quickly"]
    B14 --> B17["DB init runs at startup"]

    B18["Operations Layer"] --> B19["No metrics"]
    B18 --> B20["No tracing"]
    B18 --> B21["No DLQ tooling"]
    B18 --> B22["No stuck job recovery"]
```

