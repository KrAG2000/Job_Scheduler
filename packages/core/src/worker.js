const os = require('os');
const { randomBytes } = require('crypto');
const config = require('./config');
const baseLogger = require('./logger');
const db = require('./db');
const QueueManager = require('./queue-manager');
const { computeBackoff } = require('./backoff');
const { JobTimeoutError } = require('./errors');
const { metrics } = require('./metrics');
const Waker = require('./waker');

class LeaseLostError extends Error {
  constructor() {
    super('Lease lost: job was cancelled or taken over by another worker');
    this.name = 'LeaseLostError';
  }
}

// Sleep that ends early on shutdown. The listener is removed after a normal wake-up,
// otherwise every idle poll would leak one listener on the long-lived stop signal.
const sleepUntilAborted = (ms, signal) => new Promise((resolve) => {
  if (signal?.aborted) return resolve();
  const onAbort = () => { clearTimeout(t); resolve(); };
  const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
  signal?.addEventListener('abort', onAbort, { once: true });
});

const rejectOnAbort = (signal) => new Promise((_, reject) => {
  signal.addEventListener('abort', () => reject(signal.reason), { once: true });
});

const truncate = (s, n = 2000) => (s && s.length > n ? `${s.slice(0, n)}...` : s);

/**
 * Pulls job IDs from Redis Streams, runs the registered handler and records the outcome
 * in Postgres.
 *
 * Correctness model (at-least-once with fencing):
 * - Postgres is the source of truth. Starting an attempt is a conditional UPDATE that
 *   bumps `attempts`. That number is the fencing token: every later write for this
 *   attempt includes `attempts = <token>`, so a worker that lost its lease (paused, slow,
 *   partitioned) cannot overwrite the result of the attempt that replaced it.
 * - A message stays in the stream's pending list until the outcome is recorded. While the
 *   handler runs, a heartbeat keeps the message's idle time low. If the worker dies,
 *   another worker reclaims the message with XAUTOCLAIM after the visibility timeout.
 * - Duplicate deliveries (relay retries, sweeper re-publishes) are harmless: the start
 *   UPDATE only succeeds for a runnable status, so finished/cancelled/in-progress jobs
 *   are acked and skipped.
 */
class Worker {
  constructor({
    handlers,
    queues = config.worker.queues || config.queues,
    concurrency = config.worker.concurrency,
    queueManager,
    consumerName = `${os.hostname()}-${process.pid}-${randomBytes(3).toString('hex')}`,
    options = {},
    logger = baseLogger,
  }) {
    this.handlers = handlers;
    this.concurrency = concurrency;
    this.queue = queueManager || new QueueManager({ queues });
    this.consumer = consumerName;
    this.opts = { ...config.worker, retry: config.retry, ...options };
    this.log = logger.child({ consumer: this.consumer });

    this.byLane = {};
    for (const s of this.queue.streams) (this.byLane[s.lane] ||= []).push(s);
    this.rr = {};

    this.inFlight = new Set();
    this.running = false;
    this.stopController = new AbortController();
    this.waker = new Waker(this.stopController.signal);
    this.slotWaiters = [];
    this.timers = [];
  }

  async start() {
    await this.queue.ensureGroups();
    this.running = true;
    this.log.info({ concurrency: this.concurrency, streams: this.queue.streams.length }, 'worker started');

    // Wake up as soon as anything is published instead of waiting for the next poll.
    this.subscriber = this.queue.redis.duplicate();
    this.subscriber.on('message', () => this.waker.wake());
    await this.subscriber.subscribe(this.queue.wakeChannel);

    this.every(this.opts.promoteIntervalMs, () => this.promote());
    this.every(this.opts.reclaimIntervalMs, () => this.reclaim());
    this.loopDone = this.loop();
  }

  async stop() {
    if (!this.running) return;
    this.running = false;
    this.stopController.abort();
    for (const t of this.timers) clearInterval(t);
    this.slotWaiters.splice(0).forEach((resolve) => resolve());
    await this.loopDone;
    await this.subscriber.quit().catch(() => {});

    // Let running jobs finish. Anything still running after the timeout keeps its
    // message pending and is reclaimed by another worker once its lease expires.
    const deadline = new Promise((r) => setTimeout(r, this.opts.shutdownTimeoutMs).unref());
    await Promise.race([Promise.allSettled([...this.inFlight]), deadline]);
    this.log.info({ abandoned: this.inFlight.size }, 'worker stopped');
  }

  every(ms, fn) {
    // Jitter spreads periodic work from many workers so they don't hit Redis in sync.
    const t = setInterval(() => {
      if (this.running) fn().catch((err) => this.log.warn({ err }, 'periodic task failed'));
    }, ms + Math.floor(Math.random() * ms * 0.2));
    this.timers.push(t);
  }

  async loop() {
    let idleMs = this.opts.pollMinMs;
    while (this.running) {
      const free = this.concurrency - this.inFlight.size;
      if (free <= 0) {
        await new Promise((resolve) => this.slotWaiters.push(resolve));
        continue;
      }

      let fetched = 0;
      try {
        fetched = await this.fetch(free);
      } catch (err) {
        this.log.error({ err }, 'fetch failed');
        if (String(err.message).includes('NOGROUP')) {
          // Redis lost the group (restart without persistence / failover): recreate it.
          await this.queue.ensureGroups().catch(() => {});
        }
        await sleepUntilAborted(1000, this.stopController.signal);
        continue;
      }

      if (fetched === 0) {
        const woken = await this.waker.sleep(idleMs);
        idleMs = woken ? this.opts.pollMinMs : Math.min(idleMs * 2, this.opts.pollMaxMs);
      } else {
        idleMs = this.opts.pollMinMs;
      }
    }
  }

  // Strict priority: lower lanes are only read when higher lanes can't fill the free
  // slots. Within a lane, start at a rotating offset so no queue/partition starves.
  async fetch(free) {
    let remaining = free;
    for (const lane of config.lanes) {
      const streams = this.byLane[lane] || [];
      const start = (this.rr[lane] = ((this.rr[lane] || 0) + 1) % (streams.length || 1));
      for (let i = 0; i < streams.length && remaining > 0 && this.running; i++) {
        const s = streams[(start + i) % streams.length];
        const messages = await this.queue.read(s, this.consumer, remaining);
        for (const msg of messages) this.dispatch(s, msg, false);
        remaining -= messages.length;
      }
      if (remaining === 0) break;
    }
    return free - remaining;
  }

  dispatch(streamKeys, msg, reclaimed) {
    const p = this.execute(streamKeys, msg, reclaimed)
      .catch((err) => {
        // Infrastructure failure (DB/Redis down). The message stays pending and is
        // reclaimed after the visibility timeout.
        this.log.error({ err, jobId: msg.jobId }, 'job execution aborted by infrastructure error');
      })
      .finally(() => {
        this.inFlight.delete(p);
        metrics.jobsInFlight.set(this.inFlight.size);
        const waiter = this.slotWaiters.shift();
        if (waiter) waiter();
      });
    this.inFlight.add(p);
    metrics.jobsInFlight.set(this.inFlight.size);
  }

  async startAttempt(jobId, reclaimed) {
    // RUNNING is only accepted on a reclaimed message: that's the crashed-owner case.
    // A fresh delivery of a RUNNING job is a duplicate and must not run concurrently.
    const { rows } = await db.pool.query(
      `UPDATE jobs SET status = 'RUNNING', attempts = attempts + 1, locked_by = $2,
              started_at = now(), updated_at = now()
       WHERE id = $1 AND (status IN ('SCHEDULED', 'QUEUED', 'RETRYING') OR ($3::boolean AND status = 'RUNNING'))
       RETURNING *`,
      [jobId, this.consumer, reclaimed],
    );
    return rows[0];
  }

  async execute(streamKeys, msg, reclaimed) {
    const { queue } = streamKeys;
    if (!msg.jobId) {
      await this.queue.ack(streamKeys, msg.id);
      return;
    }

    const job = await this.startAttempt(msg.jobId, reclaimed);
    if (!job) {
      metrics.jobsSkipped.inc({ queue, reason: 'not_runnable' });
      await this.queue.ack(streamKeys, msg.id);
      return;
    }

    const type = this.handlers[job.type] ? job.type : 'unknown';
    const log = this.log.child({ jobId: job.id, type: job.type, attempt: job.attempts });
    if (msg.enq && !reclaimed) {
      metrics.jobQueueLatency.observe({ queue, lane: streamKeys.lane }, (Date.now() - Number(msg.enq)) / 1000);
    }

    // A message that keeps getting reclaimed (worker crashes every time: poison message)
    // still burns an attempt per delivery, so it eventually lands in the DLQ.
    if (job.attempts > job.max_attempts) {
      log.warn('exceeded max attempts without a recorded failure (crash loop?)');
      await this.recordFailure(streamKeys, msg, job, new Error('Exceeded max attempts (worker crashed or lost lease repeatedly)'), false, log);
      return;
    }

    const handler = this.handlers[job.type];
    if (!handler) {
      await this.recordFailure(streamKeys, msg, job, new Error(`No handler registered for type "${job.type}"`), false, log);
      return;
    }

    log.debug('job started');
    const endTimer = metrics.jobDuration.startTimer({ queue, type });
    let result;
    try {
      result = await this.runWithLease(streamKeys, msg, job, handler, log);
    } catch (err) {
      endTimer();
      if (err instanceof LeaseLostError) {
        metrics.leaseLost.inc({ queue });
        await this.resolveFenceMiss(streamKeys, msg, job, log);
        return;
      }
      const retryable = err.retryable !== false;
      metrics.jobsProcessed.inc({ queue, type, outcome: retryable && job.attempts < job.max_attempts ? 'retry' : 'dead' });
      await this.recordFailure(streamKeys, msg, job, err, retryable, log);
      return;
    }
    endTimer();

    const { rowCount } = await db.pool.query(
      `UPDATE jobs SET status = 'SUCCEEDED', result = $3, finished_at = now(), updated_at = now(), locked_by = NULL
       WHERE id = $1 AND attempts = $2 AND status = 'RUNNING'`,
      [job.id, job.attempts, JSON.stringify(result === undefined ? null : result)],
    );
    if (rowCount === 1) {
      await this.queue.ack(streamKeys, msg.id);
      metrics.jobsProcessed.inc({ queue, type, outcome: 'success' });
      log.info('job succeeded');
    } else {
      await this.resolveFenceMiss(streamKeys, msg, job, log);
    }
  }

  async runWithLease(streamKeys, msg, job, handler, log) {
    const controller = new AbortController();

    const heartbeat = setInterval(async () => {
      try {
        const owns = await this.queue.heartbeat(streamKeys, this.consumer, msg.id);
        const { rowCount } = await db.pool.query(
          `UPDATE jobs SET updated_at = now() WHERE id = $1 AND attempts = $2 AND status = 'RUNNING'`,
          [job.id, job.attempts],
        );
        if (!owns || rowCount === 0) controller.abort(new LeaseLostError());
      } catch (err) {
        log.warn({ err }, 'heartbeat failed');
      }
    }, this.opts.heartbeatMs);
    const timeout = setTimeout(() => controller.abort(new JobTimeoutError(job.timeout_ms)), job.timeout_ms);

    const ctx = {
      signal: controller.signal,
      log,
      jobId: job.id,
      attempt: job.attempts,
      maxAttempts: job.max_attempts,
    };
    const jobView = {
      id: job.id,
      type: job.type,
      queue: job.queue,
      priority: job.priority,
      payload: job.payload,
      attempt: job.attempts,
      maxAttempts: job.max_attempts,
      createdAt: job.created_at,
    };

    try {
      // JS can't kill a running promise: a handler that ignores ctx.signal keeps running
      // after a timeout, but its result is discarded and the attempt is recorded as failed.
      return await Promise.race([
        Promise.resolve().then(() => handler(jobView, ctx)),
        rejectOnAbort(controller.signal),
      ]);
    } finally {
      clearInterval(heartbeat);
      clearTimeout(timeout);
    }
  }

  async recordFailure(streamKeys, msg, job, err, retryable, log) {
    const error = truncate(err.message || String(err));
    if (retryable && job.attempts < job.max_attempts) {
      const delayMs = computeBackoff(job.attempts, this.opts.retry);
      const { rowCount } = await db.pool.query(
        `UPDATE jobs SET status = 'RETRYING', last_error = $3, locked_by = NULL,
                run_at = now() + ($4::int * interval '1 millisecond'), updated_at = now()
         WHERE id = $1 AND attempts = $2 AND status = 'RUNNING'`,
        [job.id, job.attempts, error, delayMs],
      );
      if (rowCount === 0) return this.resolveFenceMiss(streamKeys, msg, job, log);
      await this.queue.retryLater(streamKeys, msg.id, job.id, Date.now() + delayMs);
      log.warn({ error, delayMs }, 'job failed, retry scheduled');
      return;
    }

    const { rowCount } = await db.pool.query(
      `UPDATE jobs SET status = 'DEAD', last_error = $3, finished_at = now(), updated_at = now(), locked_by = NULL
       WHERE id = $1 AND attempts = $2 AND status = 'RUNNING'`,
      [job.id, job.attempts, error],
    );
    if (rowCount === 0) return this.resolveFenceMiss(streamKeys, msg, job, log);
    await this.queue.deadLetter(streamKeys, msg.id, job.id, error);
    log.error({ error }, 'job moved to dead letter queue');
  }

  // Our fenced write matched nothing. Either the job was cancelled during this attempt
  // (ack: nothing else will handle this message) or another worker took over (don't
  // ack: the message now belongs to that worker's attempt).
  async resolveFenceMiss(streamKeys, msg, job, log) {
    const { rows } = await db.pool.query('SELECT status, attempts FROM jobs WHERE id = $1', [job.id]);
    const current = rows[0];
    if (!current || (current.attempts === job.attempts && current.status !== 'RUNNING')) {
      await this.queue.ack(streamKeys, msg.id);
      metrics.jobsSkipped.inc({ queue: streamKeys.queue, reason: current ? current.status.toLowerCase() : 'missing' });
      log.info({ status: current?.status }, 'job finished elsewhere (cancelled?), acked');
    } else {
      log.warn({ status: current.status, attempts: current.attempts }, 'lost lease; result discarded');
    }
  }

  async promote() {
    const pipeline = this.queue.redis.pipeline();
    const now = Date.now();
    for (const s of this.queue.streams) pipeline.promoteDue(s.delayed, s.stream, now, 500);
    const results = await pipeline.exec();
    let promoted = 0;
    results.forEach(([err, n], i) => {
      if (!err && n > 0) {
        promoted += n;
        metrics.jobsPromoted.inc({ queue: this.queue.streams[i].queue }, n);
      }
    });
    if (promoted > 0) await this.queue.redis.publish(this.queue.wakeChannel, '1');
  }

  async reclaim() {
    for (const s of this.queue.streams) {
      const free = this.concurrency - this.inFlight.size;
      if (free <= 0 || !this.running) return;
      const messages = await this.queue.reclaim(s, this.consumer, this.opts.visibilityTimeoutMs, free);
      for (const msg of messages) {
        metrics.jobsReclaimed.inc({ queue: s.queue });
        this.log.warn({ jobId: msg.jobId, messageId: msg.id }, 'reclaimed abandoned message');
        this.dispatch(s, msg, true);
      }
    }
  }
}

module.exports = Worker;
module.exports.LeaseLostError = LeaseLostError;
module.exports.sleepUntilAborted = sleepUntilAborted;
