-- Baseline: the schema as it existed before migrations were introduced.
CREATE TABLE IF NOT EXISTS jobs (
  id UUID PRIMARY KEY,
  redis_id VARCHAR(255),
  status VARCHAR(50) NOT NULL DEFAULT 'PENDING',
  payload JSONB,
  result JSONB,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sites (
  id UUID PRIMARY KEY,
  domain VARCHAR(255) NOT NULL,
  api_key VARCHAR(255) UNIQUE NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS analytics_events (
  id UUID PRIMARY KEY,
  site_id UUID REFERENCES sites(id),
  type VARCHAR(50) NOT NULL,
  data JSONB,
  ip_address VARCHAR(45),
  user_agent TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
