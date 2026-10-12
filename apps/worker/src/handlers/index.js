// Job type -> handler. A handler receives (job, ctx) and returns a JSON-serialisable
// result. ctx.signal is aborted on timeout, cancellation or lost lease. Throw
// NonRetryableError to skip retries. Handlers must be idempotent: delivery is
// at-least-once.
module.exports = {
  demo: require('./demo'),
  email: require('./email'),
  process_analytics_event: require('./analytics'),
};
