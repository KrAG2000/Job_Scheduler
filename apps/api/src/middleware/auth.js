const crypto = require('crypto');
const AppError = require('../utils/AppError');

const safeEqual = (a, b) => {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
};

// API-key auth. Disabled when no keys are configured (local development).
const auth = (apiKeys) => (req, res, next) => {
  if (apiKeys.length === 0) return next();

  const header = req.get('authorization');
  const key = req.get('x-api-key') || (header?.startsWith('Bearer ') ? header.slice(7) : undefined);
  if (!key || !apiKeys.some((k) => safeEqual(k, key))) {
    return next(new AppError(401, 'Missing or invalid API key'));
  }
  req.principal = `key:${crypto.createHash('sha256').update(key).digest('hex').slice(0, 16)}`;
  return next();
};

module.exports = auth;
