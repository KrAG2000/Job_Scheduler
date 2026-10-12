const config = require('./config');
const baseLogger = require('./logger');
const db = require('./db');
const QueueManager = require('./queue-manager');
const { insertJob, OUTBOX_CHANNEL } = require('./jobs');
const { nextRun } = require('./cron');
const { metrics } = require('./metrics');
const Waker = require('./waker');

/**
 * Control-plane loops. Every loop coordinates through Postgres row locks
 * (FOR UPDATE SKIP LOCKED) or idempotent Redis operations, so any number of scheduler
 * replicas can run at once without leader election: replicas split the work instead of
 * one being active and the rest idle.
 */
class Scheduler {
  constructor({ queueManager, options = {}, logger = baseLogger } = {}) {
    this.queue = queueManager || new QueueManager();
    this.opts = { ...config.scheduler, ...options };
    this.log = logger.child({ component: 'scheduler' });
    this.running = false;
    this.loops = [];
    this.stopController = new AbortController();
    this.relayWaker = new Waker(this.stopController.signal);
  }

  async start() {
    await this.queue.ensureGroups();
    this.running = true;
    await this.listen();
    this.loops = [
      this.loop('relay', this.opts.relayIntervalMs, () => this.relayOnce(), this.relayWaker),
      this.loop('cron', this.opts.cronIntervalMs, () => this.cronOnce()),
      this.loop('sweeper', this.opts.sweepIntervalMs, () => this.sweepOnce()),
      this.loop('maintenance', this.opts.maintenanceIntervalMs, () => this.maintenanceOnce()),
    ];
    this.log.info('scheduler started');
  }

  async stop() {
    this.running = false;
    this.stopController.abort();
    await this.listener?.quit().catch(() => {});
    await Promise.all(this.loops);
    this.log.info('scheduler stopped');
  }

  // Subscribe to "new outbox work" hints so the relay publishes a job milliseconds after
  // its transaction commits. Polling remains the fallback, and is how future-dated jobs
  // are found.
  async listen() {
    this.listener = this.queue.redis.duplicate();
    this.listener.on('message', () => this.relayWaker.wake());
    await this.listener.subscribe(OUTBOX_CHANNEL);
  }

  // Runs fn repeatedly; if it reports a full batch (returns true) it runs again at once
  // to drain backlog instead of waiting for the next tick.
  async loop(name, intervalMs, fn, waker = new Waker(this.stopController.signal)) {
    while (this.running) {
      let more = false;
      try {
        more = await fn();
      } catch (err) {
        this.log.error({ err, loop: name }, 'scheduler loop failed');
      }
      if (!more && this.running) await waker.sleep(intervalMs);
    }
  }

  /**
   * Transactional outbox relay. Rows stay locked while we XADD; if Redis fails the
   * transaction rolls back and the rows are retried. If the commit fails after XADD
   * succeeded the job is published twice, which workers detect and skip.
   * Future-dated rows (scheduled jobs) are simply not yet "available".
   */
  async relayOnce() {
    const batch = this.opts.relayBatchSize;
    const published = await db.withTransaction(async (client) => {
      const { rows } = await client.query(
        `SELECT o.id AS outbox_id, j.id, j.queue, j.priority, j.type
         FROM outbox o JOIN jobs j ON j.id = o.job_id
         WHERE o.available_at <= now()
         ORDER BY o.available_at
         LIMIT $1
         FOR UPDATE OF o SKIP LOCKED`,
        [batch],
      );
      if (rows.length === 0) return 0;

      await this.queue.publish(rows);
      await client.query('DELETE FROM outbox WHERE id = ANY($1::bigint[])', [rows.map((r) => r.outbox_id)]);
      await client.query(
        `UPDATE jobs SET status = 'QUEUED', updated_at = now()
         WHERE id = ANY($1::uuid[]) AND status = 'SCHEDULED'`,
        [rows.map((r) => r.id)],
      );
      return rows.length;
    });
    if (published > 0) metrics.outboxRelayed.inc(published);
    return published === batch;
  }

  /**
   * Fire due cron schedules. The row lock means only one replica handles a given
   * schedule at a time, and the idempotency key `cron:<name>:<tick>` guarantees one job
   * per tick even if the same tick is somehow processed twice.
   * Misfire policy: if we were down for several ticks, fire once and skip ahead.
   */
  async cronOnce() {
    return db.withTransaction(async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM cron_schedules WHERE enabled AND next_run_at <= now()
         ORDER BY next_run_at LIMIT 100 FOR UPDATE SKIP LOCKED`,
      );
      for (const s of rows) {
        const tick = s.next_run_at;
        const { created } = await insertJob(client, {
          type: s.type,
          payload: s.payload,
          queue: s.queue,
          priority: s.priority,
          maxAttempts: s.max_attempts,
          timeoutMs: s.timeout_ms,
          idempotencyKey: `cron:${s.name}:${tick.toISOString()}`,
          scheduleName: s.name,
        });
        let next;
        try {
          next = nextRun(s.cron, s.timezone, new Date(Math.max(Date.now(), tick.getTime())));
        } catch (err) {
          this.log.error({ err, schedule: s.name }, 'invalid cron expression, disabling schedule');
          await client.query('UPDATE cron_schedules SET enabled = false, updated_at = now() WHERE name = $1', [s.name]);
          continue;
        }
        await client.query(
          'UPDATE cron_schedules SET next_run_at = $2, last_run_at = $3, updated_at = now() WHERE name = $1',
          [s.name, next, tick],
        );
        if (created) {
          this.relayWaker.wake();
          metrics.cronFired.inc({ schedule: s.name });
          this.log.info({ schedule: s.name, tick, next }, 'cron fired');
        }
      }
      return rows.length === 100;
    });
  }

  /**
   * Safety net for anything Redis lost (failover with un-replicated writes, AOF loss,
   * accidental FLUSHALL) or a worker that died without its message being reclaimable.
   * Postgres knows every job that should be making progress; anything that has been
   * idle too long is put back in the outbox. Duplicates are skipped by workers.
   */
  async sweepOnce() {
    const stuckMs = this.opts.stuckAfterMs;
    const { rows } = await db.pool.query(
      `WITH stuck AS (
         SELECT id, status FROM jobs
         WHERE ((status = 'QUEUED' AND updated_at < now() - ($1::int * interval '1 millisecond'))
             OR (status = 'RETRYING' AND run_at < now() - ($1::int * interval '1 millisecond'))
             OR (status = 'RUNNING' AND updated_at < now() - ($1::int * interval '1 millisecond')))
           AND NOT EXISTS (SELECT 1 FROM outbox o WHERE o.job_id = jobs.id)
         LIMIT 1000
         FOR UPDATE SKIP LOCKED
       ), touched AS (
         -- RUNNING with no heartbeat for this long: the owner is gone. Moving it back to
         -- QUEUED also fences the old owner (its writes require status = 'RUNNING').
         UPDATE jobs SET status = CASE WHEN jobs.status = 'RUNNING' THEN 'QUEUED' ELSE jobs.status END,
                         updated_at = now(), locked_by = NULL
         FROM stuck WHERE jobs.id = stuck.id
         RETURNING jobs.id, stuck.status AS old_status
       ), ins AS (
         INSERT INTO outbox (job_id) SELECT id FROM touched
       )
       SELECT old_status, count(*)::int AS n FROM touched GROUP BY old_status`,
      [stuckMs],
    );
    if (rows.length) this.relayWaker.wake();
    for (const r of rows) {
      metrics.sweeperRequeued.inc({ status: r.old_status }, r.n);
      this.log.warn({ status: r.old_status, count: r.n }, 'sweeper re-published stuck jobs');
    }
    return false;
  }

  async maintenanceOnce() {
    const trimmed = await this.queue.trim();
    if (trimmed > 0) metrics.streamTrimmed.inc(trimmed);
    await this.queue.cleanupConsumers(this.opts.consumerIdleCleanupMs);
    return false;
  }
}

module.exports = Scheduler;
