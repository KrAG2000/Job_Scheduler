const config = require('./config');
const logger = require('./logger');
const { getRedis } = require('./redis-client');
const { keysForJob, allStreams } = require('./keys');

// Redis returns XINFO replies as flat [k1, v1, k2, v2, ...] arrays.
const pairsToObject = (arr) => {
  const out = {};
  for (let i = 0; i < arr.length; i += 2) out[arr[i]] = arr[i + 1];
  return out;
};

const parseMessage = ([id, fields]) => ({ id, ...pairsToObject(fields || []) });

// Compare two stream IDs ("ms-seq").
const compareIds = (a, b) => {
  const [am, as] = a.split('-').map(BigInt);
  const [bm, bs] = b.split('-').map(BigInt);
  if (am !== bm) return am < bm ? -1 : 1;
  if (as !== bs) return as < bs ? -1 : 1;
  return 0;
};

/**
 * Everything that talks to Redis Streams. Redis only carries job IDs (the "claim check"
 * pattern); the job itself lives in Postgres, which is the source of truth. Losing Redis
 * data therefore delays jobs (the sweeper re-publishes them) but never loses them.
 */
class QueueManager {
  constructor({ redis = getRedis(), queues = config.queues, partitions = config.partitions,
    prefix = config.keyPrefix, group = config.group } = {}) {
    this.redis = redis;
    this.group = group;
    this.prefix = prefix;
    this.partitions = partitions;
    this.streams = allStreams({ queues, partitions, prefix });
    // Pub/sub channel that tells idle workers new messages are available.
    this.wakeChannel = `${prefix}:wake`;
  }

  keysFor(job) {
    return keysForJob(job, { partitions: this.partitions, prefix: this.prefix });
  }

  async ensureGroups() {
    const pipeline = this.redis.pipeline();
    for (const s of this.streams) pipeline.xgroup('CREATE', s.stream, this.group, '0', 'MKSTREAM');
    const results = await pipeline.exec();
    for (const [err] of results) {
      if (err && !err.message.includes('BUSYGROUP')) throw err;
    }
  }

  // jobs: [{ id, queue, priority, type }]
  async publish(jobs) {
    if (jobs.length === 0) return;
    const now = Date.now();
    const pipeline = this.redis.pipeline();
    for (const job of jobs) {
      pipeline.xadd(this.keysFor(job).stream, '*', 'jobId', job.id, 'enq', now);
    }
    pipeline.publish(this.wakeChannel, '1');
    const results = await pipeline.exec();
    const failed = results.find(([err]) => err);
    if (failed) throw failed[0];
  }

  // Non-blocking read of up to `count` new messages from one stream.
  async read(streamKeys, consumer, count) {
    const res = await this.redis.xreadgroup(
      'GROUP', this.group, consumer, 'COUNT', count, 'STREAMS', streamKeys.stream, '>',
    );
    if (!res) return [];
    return res[0][1].map(parseMessage);
  }

  ack(streamKeys, messageId) {
    return this.redis.xack(streamKeys.stream, this.group, messageId);
  }

  retryLater(streamKeys, messageId, jobId, runAtMs) {
    return this.redis.retryLater(streamKeys.stream, streamKeys.delayed, this.group, jobId, runAtMs, messageId);
  }

  deadLetter(streamKeys, messageId, jobId, error) {
    return this.redis.deadLetter(
      streamKeys.stream, streamKeys.dlq, this.group, jobId, error, Date.now(),
      config.scheduler.dlqMaxLen, messageId,
    );
  }

  // Returns false when another consumer has taken the message over.
  async heartbeat(streamKeys, consumer, messageId) {
    return (await this.redis.heartbeat(streamKeys.stream, this.group, consumer, messageId)) === 1;
  }

  // Take over messages whose owner stopped heartbeating (crashed, hung or partitioned).
  async reclaim(streamKeys, consumer, minIdleMs, count) {
    const [, messages] = await this.redis.xautoclaim(
      streamKeys.stream, this.group, consumer, minIdleMs, '0-0', 'COUNT', count,
    );
    // Entries trimmed from the stream come back with null fields; nothing to run.
    return messages.filter((m) => m && m[1]).map(parseMessage);
  }

  async promoteDue(streamKeys, limit = 500) {
    return this.redis.promoteDue(streamKeys.delayed, streamKeys.stream, Date.now(), limit);
  }

  // Per-stream depth: lag = not yet delivered, pending = delivered but not acked.
  async streamStats() {
    const pipeline = this.redis.pipeline();
    for (const s of this.streams) {
      pipeline.xinfo('GROUPS', s.stream);
      pipeline.zcard(s.delayed);
      pipeline.xlen(s.dlq);
    }
    const results = await pipeline.exec();
    return this.streams.map((s, i) => {
      const [groupsErr, groups] = results[i * 3];
      const group = groupsErr ? null : groups.map(pairsToObject).find((g) => g.name === this.group);
      return {
        queue: s.queue,
        lane: s.lane,
        partition: s.partition,
        lag: group ? Number(group.lag ?? 0) : 0,
        pending: group ? Number(group.pending) : 0,
        delayed: Number(results[i * 3 + 1][1] || 0),
        dlq: Number(results[i * 3 + 2][1] || 0),
      };
    });
  }

  async backlogByQueue() {
    const out = {};
    for (const s of await this.streamStats()) {
      out[s.queue] = (out[s.queue] || 0) + s.lag + s.pending;
    }
    return out;
  }

  /**
   * Trim entries that every consumer has already processed. XACK does not delete
   * anything, so without this the streams grow forever. MAXLEN would be unsafe: it can
   * drop messages that were never delivered. Instead trim strictly below both the
   * group's last-delivered ID and the oldest still-pending ID.
   */
  // approximate (~) lets Redis drop whole internal nodes only, which is much cheaper.
  async trim({ approximate = true } = {}) {
    let trimmed = 0;
    for (const s of this.streams) {
      try {
        const groups = (await this.redis.xinfo('GROUPS', s.stream)).map(pairsToObject);
        if (groups.length === 0) continue;
        let safe = null;
        for (const g of groups) {
          let bound = g['last-delivered-id'];
          if (Number(g.pending) > 0) {
            const [, minPending] = await this.redis.xpending(s.stream, g.name);
            if (minPending && compareIds(minPending, bound) < 0) bound = minPending;
          }
          if (safe === null || compareIds(bound, safe) < 0) safe = bound;
        }
        if (safe && safe !== '0-0') {
          trimmed += await this.redis.xtrim(s.stream, 'MINID', ...(approximate ? ['~'] : []), safe);
        }
      } catch (err) {
        if (!String(err.message).includes('no such key')) logger.warn({ err, stream: s.stream }, 'trim failed');
      }
    }
    return trimmed;
  }

  // Remove consumers left behind by dead worker processes (each run has a unique name).
  async cleanupConsumers(idleMs) {
    let removed = 0;
    for (const s of this.streams) {
      try {
        const consumers = (await this.redis.xinfo('CONSUMERS', s.stream, this.group)).map(pairsToObject);
        for (const c of consumers) {
          if (Number(c.pending) === 0 && Number(c.idle) > idleMs) {
            await this.redis.xgroup('DELCONSUMER', s.stream, this.group, c.name);
            removed++;
          }
        }
      } catch (err) {
        if (!String(err.message).includes('NOGROUP')) logger.warn({ err, stream: s.stream }, 'consumer cleanup failed');
      }
    }
    return removed;
  }
}

module.exports = QueueManager;
module.exports.compareIds = compareIds;
module.exports.parseMessage = parseMessage;
