require('dotenv').config();
const { QueueManager, db } = require('@scheduler/core');

const queue = new QueueManager('jobs_stream');
const WORKER_ID = `worker-${process.pid}`;
const GROUP_NAME = 'workers_group';

db.initDB();

const processJob = async (id, jobData) => {
  const { jobId, type, payload } = jobData;
  console.log(`[${WORKER_ID}] Processing job ${jobId} (${type})...`);

  await db.pool.query(
    'UPDATE jobs SET status = $1, updated_at = NOW() WHERE id = $2',
    ['PROCESSING', jobId]
  );

  await new Promise(resolve => setTimeout(resolve, 2000));

  if (Math.random() < 0.1) {
    throw new Error('Random simulated failure');
  }

  await db.pool.query(
    'UPDATE jobs SET status = $1, result = $2, updated_at = NOW() WHERE id = $3',
    ['COMPLETED', JSON.stringify({ success: true, processedBy: WORKER_ID }), jobId]
  );

  console.log(`[${WORKER_ID}] Job ${jobId} completed.`);
};

const startWorker = async () => {
  console.log(`[${WORKER_ID}] Starting...`);

  const safeHandler = async (id, jobData) => {
    try {
      await processJob(id, jobData);
    } catch (err) {
      console.error(`[${WORKER_ID}] Job ${jobData.jobId} failed:`, err.message);
      await db.pool.query(
        'UPDATE jobs SET status = $1, result = $2, updated_at = NOW() WHERE id = $3',
        ['FAILED', JSON.stringify({ error: err.message }), jobData.jobId]
      );
      throw err; // Re-throw to let QueueManager handle retry/DLQ logic if implemented
    }
  };

  await queue.processGroup(GROUP_NAME, WORKER_ID, safeHandler);
};

startWorker().catch(err => {
  console.error('Worker failed to start:', err);
});
