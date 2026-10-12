const config = require('./config');
const { ValidationError } = require('./errors');

const TYPE_RE = /^[A-Za-z0-9_.:-]{1,100}$/;
const NAME_RE = /^[A-Za-z0-9_.:-]{1,100}$/;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

const intInRange = (value, name, min, max) => {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ValidationError(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
};

// Shared by jobs and cron schedules.
const validateCommon = (body) => {
  if (!isPlainObject(body)) throw new ValidationError('Body must be a JSON object');

  const { type, payload = {}, queue = 'default', priority = 'normal' } = body;
  if (typeof type !== 'string' || !TYPE_RE.test(type)) {
    throw new ValidationError('type must match [A-Za-z0-9_.:-]{1,100}');
  }
  if (!isPlainObject(payload)) throw new ValidationError('payload must be an object');
  if (!config.queues.includes(queue)) {
    throw new ValidationError(`queue must be one of: ${config.queues.join(', ')}`);
  }
  if (!config.lanes.includes(priority)) {
    throw new ValidationError(`priority must be one of: ${config.lanes.join(', ')}`);
  }

  return {
    type,
    payload,
    queue,
    priority,
    maxAttempts: body.maxAttempts === undefined
      ? config.jobDefaults.maxAttempts
      : intInRange(body.maxAttempts, 'maxAttempts', 1, 25),
    timeoutMs: body.timeoutMs === undefined
      ? config.jobDefaults.timeoutMs
      : intInRange(body.timeoutMs, 'timeoutMs', 100, 60 * 60 * 1000),
  };
};

const validateJob = (body, { idempotencyKey } = {}) => {
  const spec = validateCommon(body);

  if (body.runAt !== undefined && body.delayMs !== undefined) {
    throw new ValidationError('Use either runAt or delayMs, not both');
  }
  if (body.runAt !== undefined) {
    const runAt = new Date(body.runAt);
    if (typeof body.runAt !== 'string' || Number.isNaN(runAt.getTime())) {
      throw new ValidationError('runAt must be an ISO-8601 timestamp');
    }
    spec.runAt = runAt;
  } else if (body.delayMs !== undefined) {
    spec.runAt = new Date(Date.now() + intInRange(body.delayMs, 'delayMs', 0, 365 * 24 * 3600 * 1000));
  }

  const key = idempotencyKey ?? body.idempotencyKey;
  if (key !== undefined) {
    if (typeof key !== 'string' || key.length === 0 || key.length > 200) {
      throw new ValidationError('idempotencyKey must be a string of 1-200 chars');
    }
    spec.idempotencyKey = key;
  }
  return spec;
};

const validateSchedule = (body) => {
  const spec = validateCommon(body);
  if (typeof body.name !== 'string' || !NAME_RE.test(body.name)) {
    throw new ValidationError('name must match [A-Za-z0-9_.:-]{1,100}');
  }
  if (typeof body.cron !== 'string') throw new ValidationError('cron is required');
  spec.name = body.name;
  spec.cron = body.cron;
  spec.timezone = body.timezone || 'UTC';
  spec.enabled = body.enabled !== false;
  return spec;
};

module.exports = { validateJob, validateSchedule };
