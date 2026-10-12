// Exponential backoff with "equal jitter": half the delay is fixed, half is random.
// The jitter stops a burst of failures from retrying in lock-step (thundering herd).
const computeBackoff = (attempt, { baseMs, maxMs }, random = Math.random) => {
  const exp = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.floor(exp / 2 + random() * (exp / 2));
};

module.exports = { computeBackoff };
