// Lua scripts run atomically on the Redis server. Each one replaces a sequence of
// commands that previously could be interrupted by a crash or raced by another worker.

const SCRIPTS = {
  // Schedule a retry and ack the current delivery in one step, so a crash can never
  // lose the job between the two (the old code acked first, then ZADDed).
  retryLater: {
    numberOfKeys: 2, // stream, delayed
    lua: `
      redis.call('ZADD', KEYS[2], ARGV[3], ARGV[2])
      return redis.call('XACK', KEYS[1], ARGV[1], ARGV[4])
    `, // ARGV: group, jobId, runAtMs, messageId
  },

  // Move to the dead-letter stream and ack atomically.
  deadLetter: {
    numberOfKeys: 2, // stream, dlq
    lua: `
      redis.call('XADD', KEYS[2], 'MAXLEN', '~', ARGV[5], '*',
        'jobId', ARGV[2], 'error', ARGV[3], 'failedAt', ARGV[4])
      return redis.call('XACK', KEYS[1], ARGV[1], ARGV[6])
    `, // ARGV: group, jobId, error, failedAtMs, dlqMaxLen, messageId
  },

  // Move due retries from the delayed ZSET back onto the stream. Because the read and
  // the ZREM happen inside one script, N workers can run this concurrently without
  // re-enqueueing the same job N times.
  promoteDue: {
    numberOfKeys: 2, // delayed, stream
    lua: `
      local due = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, ARGV[2])
      for _, jobId in ipairs(due) do
        redis.call('XADD', KEYS[2], '*', 'jobId', jobId, 'enq', ARGV[1])
        redis.call('ZREM', KEYS[1], jobId)
      end
      return #due
    `, // ARGV: nowMs, limit
  },

  // Heartbeat: reset the message's idle time, but only if this consumer still owns
  // it. A plain XCLAIM would steal the message back from a worker that reclaimed it.
  heartbeat: {
    numberOfKeys: 1, // stream
    lua: `
      local p = redis.call('XPENDING', KEYS[1], ARGV[1], ARGV[3], ARGV[3], 1)
      if #p == 1 and p[1][2] == ARGV[2] then
        redis.call('XCLAIM', KEYS[1], ARGV[1], ARGV[2], 0, ARGV[3], 'JUSTID')
        return 1
      end
      return 0
    `, // ARGV: group, consumer, messageId
  },

  // Token bucket rate limiter. Uses the Redis clock so every API instance agrees.
  // Returns {allowed, tokensLeft, retryAfterMs}.
  tokenBucket: {
    numberOfKeys: 1,
    lua: `
      local capacity = tonumber(ARGV[1])
      local refill = tonumber(ARGV[2]) -- tokens per second
      local cost = tonumber(ARGV[3])
      local t = redis.call('TIME')
      local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
      local state = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
      local tokens = tonumber(state[1]) or capacity
      local ts = tonumber(state[2]) or now
      tokens = math.min(capacity, tokens + (now - ts) * refill / 1000)
      local allowed = 0
      local retryAfter = 0
      if tokens >= cost then
        tokens = tokens - cost
        allowed = 1
      else
        retryAfter = math.ceil((cost - tokens) * 1000 / refill)
      end
      redis.call('HSET', KEYS[1], 'tokens', tokens, 'ts', now)
      redis.call('PEXPIRE', KEYS[1], math.ceil(capacity * 1000 / refill) + 1000)
      return {allowed, math.floor(tokens), retryAfter}
    `, // ARGV: capacity, refillPerSec, cost
  },
};

const defineScripts = (client) => {
  for (const [name, def] of Object.entries(SCRIPTS)) {
    client.defineCommand(name, def);
  }
};

module.exports = { defineScripts, SCRIPTS };
