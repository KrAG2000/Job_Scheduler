const { db } = require('@scheduler/core');

// The job ID doubles as the event's primary key, so a retried or duplicated delivery
// inserts nothing the second time (idempotent side effect).
const processAnalyticsEvent = async (job) => {
  const { siteId, eventType, data, ipAddress, userAgent, timestamp } = job.payload;
  const { rowCount } = await db.pool.query(
    `INSERT INTO analytics_events (id, site_id, type, data, ip_address, user_agent, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (id) DO NOTHING`,
    [job.id, siteId, eventType, JSON.stringify(data || {}), ipAddress, userAgent, timestamp],
  );
  return { inserted: rowCount === 1 };
};

module.exports = processAnalyticsEvent;
