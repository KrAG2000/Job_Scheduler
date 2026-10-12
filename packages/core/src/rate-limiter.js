const config = require('./config');
const { getRedis } = require('./redis-client');
const { withTimeout } = require('./timeout');

// Distributed token bucket: state lives in Redis so the limit holds across all API
// instances behind the load balancer.
const consume = async (key, {
  capacity = config.api.rateLimitCapacity,
  refillPerSec = config.api.rateLimitRefillPerSec,
  cost = 1,
  redis = getRedis(),
  timeoutMs = 250,
} = {}) => {
  const [allowed, remaining, retryAfterMs] = await withTimeout(
    redis.tokenBucket(`${config.keyPrefix}:ratelimit:${key}`, capacity, refillPerSec, cost),
    timeoutMs,
    'rate limiter',
  );
  return { allowed: allowed === 1, remaining, retryAfterMs };
};

module.exports = { consume };
