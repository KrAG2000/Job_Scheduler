const { rateLimiter, logger, metrics: { metrics } } = require('@scheduler/core');

// Token bucket per caller. `cost` lets a batch request consume one token per job.
// Fails open: if Redis is down we still accept jobs (they are durable in Postgres).
const rateLimit = ({ cost = () => 1, limiter = rateLimiter } = {}) => async (req, res, next) => {
  try {
    const key = req.principal || `ip:${req.ip}`;
    const { allowed, remaining, retryAfterMs } = await limiter.consume(key, { cost: cost(req) });
    res.set('X-RateLimit-Remaining', String(remaining));
    if (!allowed) {
      res.set('Retry-After', String(Math.ceil(retryAfterMs / 1000)));
      metrics.jobsRejected.inc({ reason: 'rate_limited' });
      return res.status(429).json({ error: 'Rate limit exceeded' });
    }
  } catch (err) {
    logger.warn({ err }, 'rate limiter unavailable, allowing request');
  }
  return next();
};

module.exports = rateLimit;
