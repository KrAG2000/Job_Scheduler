// Throw from a handler to skip the remaining retries and dead-letter immediately
// (e.g. invalid payload: retrying will never help).
class NonRetryableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NonRetryableError';
    this.retryable = false;
  }
}

class JobTimeoutError extends Error {
  constructor(timeoutMs) {
    super(`Job timed out after ${timeoutMs}ms`);
    this.name = 'JobTimeoutError';
  }
}

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.statusCode = 400;
  }
}

module.exports = { NonRetryableError, JobTimeoutError, ValidationError };
