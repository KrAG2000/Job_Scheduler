const { NonRetryableError } = require('@scheduler/core');

// Stand-in for a real email provider call. A real implementation would pass job.id
// as the provider's idempotency key so retries can't send the email twice.
const sendEmail = async (job, ctx) => {
  const { to, subject } = job.payload;
  if (!to) throw new NonRetryableError('payload.to is required');
  await new Promise((resolve) => setTimeout(resolve, 50));
  ctx.log.info({ to, subject }, 'email sent (simulated)');
  return { delivered: true, to };
};

module.exports = sendEmail;
