// A real worker process for crash tests (the parent sends it SIGKILL).
const { core, fastWorkerOptions } = require('../helpers');
const handlers = require('../../../apps/worker/src/handlers');

process.env.KEY_PREFIX = process.argv[2];
const worker = new core.Worker({
  handlers,
  concurrency: 4,
  queueManager: new core.QueueManager({ prefix: process.argv[2] }),
  options: { ...fastWorkerOptions, visibilityTimeoutMs: 60000 },
});
worker.start().then(() => process.send?.('ready'));
