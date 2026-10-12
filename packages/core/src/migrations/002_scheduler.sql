-- Jobs become the source of truth for the whole lifecycle.
ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS type TEXT,
  ADD COLUMN IF NOT EXISTS queue TEXT NOT NULL DEFAULT 'default',
  ADD COLUMN IF NOT EXISTS priority TEXT NOT NULL DEFAULT 'normal',
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT,
  ADD COLUMN IF NOT EXISTS attempts INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS max_attempts INT NOT NULL DEFAULT 4,
  ADD COLUMN IF NOT EXISTS timeout_ms INT NOT NULL DEFAULT 30000,
  ADD COLUMN IF NOT EXISTS run_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS last_error TEXT,
  ADD COLUMN IF NOT EXISTS locked_by TEXT,
  ADD COLUMN IF NOT EXISTS schedule_name TEXT,
  ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS finished_at TIMESTAMPTZ;

ALTER TABLE jobs DROP COLUMN IF EXISTS redis_id;
ALTER TABLE jobs ALTER COLUMN created_at TYPE TIMESTAMPTZ, ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE jobs ALTER COLUMN updated_at TYPE TIMESTAMPTZ, ALTER COLUMN updated_at SET DEFAULT now();

-- Old rows stored {type, payload} together in the payload column.
UPDATE jobs SET type = payload->>'type', payload = payload->'payload'
  WHERE type IS NULL AND payload ? 'type';
UPDATE jobs SET type = 'unknown' WHERE type IS NULL;
ALTER TABLE jobs ALTER COLUMN type SET NOT NULL;

-- Old state names -> new state machine. Old PENDING rows have no outbox entry; the
-- stuck-job sweeper re-publishes them.
UPDATE jobs SET status = CASE status
  WHEN 'PENDING' THEN 'QUEUED'
  WHEN 'PROCESSING' THEN 'RUNNING'
  WHEN 'COMPLETED' THEN 'SUCCEEDED'
  WHEN 'FAILED' THEN 'DEAD'
  ELSE status END;
ALTER TABLE jobs ALTER COLUMN status SET DEFAULT 'QUEUED';
ALTER TABLE jobs ADD CONSTRAINT jobs_status_check
  CHECK (status IN ('SCHEDULED', 'QUEUED', 'RUNNING', 'RETRYING', 'SUCCEEDED', 'DEAD', 'CANCELLED'));
ALTER TABLE jobs ADD CONSTRAINT jobs_priority_check CHECK (priority IN ('high', 'normal', 'low'));

CREATE UNIQUE INDEX IF NOT EXISTS jobs_idempotency_key_idx ON jobs (idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS jobs_status_created_idx ON jobs (status, created_at DESC, id);
CREATE INDEX IF NOT EXISTS jobs_queue_status_created_idx ON jobs (queue, status, created_at DESC, id);
-- Partial index keeps the sweeper's scan cheap: only non-terminal rows are indexed.
CREATE INDEX IF NOT EXISTS jobs_active_idx ON jobs (status, updated_at)
  WHERE status IN ('QUEUED', 'RETRYING', 'RUNNING');

-- Transactional outbox: written in the same transaction as the job row, published to
-- Redis by the scheduler's relay. Also holds future-dated (scheduled) jobs.
CREATE TABLE IF NOT EXISTS outbox (
  id BIGSERIAL PRIMARY KEY,
  job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS outbox_available_idx ON outbox (available_at);
CREATE INDEX IF NOT EXISTS outbox_job_idx ON outbox (job_id);

CREATE TABLE IF NOT EXISTS cron_schedules (
  name TEXT PRIMARY KEY,
  cron TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  queue TEXT NOT NULL DEFAULT 'default',
  priority TEXT NOT NULL DEFAULT 'normal',
  max_attempts INT NOT NULL DEFAULT 4,
  timeout_ms INT NOT NULL DEFAULT 30000,
  enabled BOOLEAN NOT NULL DEFAULT true,
  next_run_at TIMESTAMPTZ NOT NULL,
  last_run_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cron_due_idx ON cron_schedules (next_run_at) WHERE enabled;

ALTER TABLE analytics_events ALTER COLUMN created_at TYPE TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS analytics_site_created_idx ON analytics_events (site_id, created_at DESC);
