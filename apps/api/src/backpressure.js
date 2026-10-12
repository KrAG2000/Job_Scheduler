const { config, logger, jobs, withTimeout, metrics: { metrics } } = require('@scheduler/core');

/**
 * Keeps a cached view of queue depth (refreshed in the background, not per request) and
 * rejects new work for a queue that is already too far behind. Shedding load at the
 * edge with 429 + Retry-After is better than accepting jobs we can't run in time.
 */
class Backpressure {
  constructor({ queueManager, maxBacklog = config.api.maxBacklog, refreshMs = 2000 }) {
    this.queue = queueManager;
    this.maxBacklog = maxBacklog;
    this.refreshMs = refreshMs;
    this.backlog = {};
    this.outboxReady = 0;
  }

  start() {
    const refresh = async () => {
      if (this.refreshing) return; // don't stack refreshes while Redis is unreachable
      this.refreshing = true;
      try {
        this.backlog = await withTimeout(this.queue.backlogByQueue(), 1000, 'backlog refresh');
        this.outboxReady = (await jobs.outboxBacklog()).ready;
      } catch (err) {
        logger.warn({ err }, 'backlog refresh failed');
      } finally {
        this.refreshing = false;
      }
    };
    refresh();
    this.timer = setInterval(refresh, this.refreshMs);
    this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
  }

  isOverloaded(queue) {
    return (this.backlog[queue] || 0) + this.outboxReady >= this.maxBacklog;
  }

  middleware(queuesOf) {
    return (req, res, next) => {
      const overloaded = queuesOf(req).find((q) => this.isOverloaded(q));
      if (overloaded) {
        metrics.jobsRejected.inc({ reason: 'backpressure' });
        res.set('Retry-After', '5');
        return res.status(429).json({ error: `Queue "${overloaded}" is overloaded, retry later` });
      }
      return next();
    };
  }
}

module.exports = Backpressure;
