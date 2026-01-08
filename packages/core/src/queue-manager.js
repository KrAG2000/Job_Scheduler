const redisClient = require('./redis-client');
const { v4: uuidv4 } = require('uuid');

class QueueManager {
  constructor(queueName) {
    this.redis = redisClient.getClient();
    this.queueName = queueName;
  }

  async addJob(data) {
    const messageId = await this.redis.xadd(
      this.queueName,
      '*', // Auto-generate ID
      'data', JSON.stringify(data),
      'status', 'PENDING',
      'created_at', Date.now()
    );
    console.log(`[Producer] Added job to ${this.queueName}: ${messageId}`);
    return messageId;
  }

  async setupConsumerGroup(groupName) {
    try {
      await this.redis.xgroup('CREATE', this.queueName, groupName, '0', 'MKSTREAM');
      console.log(`[Consumer] Created group ${groupName} for ${this.queueName}`);
    } catch (err) {
      if (!err.message.includes('BUSYGROUP')) {
        throw err;
      }
    }
  }

  async processGroup(groupName, consumerName, handler) {
    await this.setupConsumerGroup(groupName);

    console.log(`[Consumer ${consumerName}] Starting loop...`);

    this.startDelayedScheduler();

    while (true) {
      try {
        const streams = await this.redis.xreadgroup(
          'GROUP', groupName, consumerName,
          'COUNT', '1',
          'BLOCK', '5000',
          'STREAMS', this.queueName, '>'
        );

        if (streams) {
          const [stream] = streams;
          const [key, messages] = stream;

          for (const message of messages) {
            const [id, fields] = message;
            const jobData = JSON.parse(fields[1]);
            const retryCount = parseInt(fields[3] || '0', 10);
            const currentRetries = jobData.retryCount || 0;

            console.log(`[Consumer ${consumerName}] Processing job ${jobData.jobId} (Attempt ${currentRetries + 1})`);

            try {
              await handler(id, jobData);

              await this.redis.xack(this.queueName, groupName, id);
              console.log(`[Consumer ${consumerName}] Acknowledged job ${jobData.jobId}`);
            } catch (err) {
              console.error(`[Consumer ${consumerName}] Job ${jobData.jobId} failed:`, err.message);
              await this.handleFailure(groupName, id, jobData, err);
            }
          }
        }
      } catch (err) {
        console.error(`[Consumer ${consumerName}] Error in loop:`, err);
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }

  async handleFailure(groupName, id, jobData, err) {
    const MAX_RETRIES = 3;
    const currentRetries = jobData.retryCount || 0;

    await this.redis.xack(this.queueName, groupName, id);

    if (currentRetries < MAX_RETRIES) {
      const nextRetry = currentRetries + 1;
      const backoff = Math.pow(2, nextRetry) * 1000;
      const nextProcessTime = Date.now() + backoff;

      jobData.retryCount = nextRetry;
      jobData.lastError = err.message;

      await this.redis.zadd(`${this.queueName}:delayed`, nextProcessTime, JSON.stringify(jobData));
      console.log(`[Consumer] Scheduled retry ${nextRetry} for job ${jobData.jobId} in ${backoff}ms`);
    } else {
      console.error(`[Consumer] Job ${jobData.jobId} exhausted retries. Moving to DLQ.`);
      jobData.failedAt = Date.now();
      jobData.error = err.message;

      await this.redis.xadd(`${this.queueName}:dlq`, '*', 'data', JSON.stringify(jobData));
    }
  }

  async startDelayedScheduler() {
    console.log('[Scheduler] Starting delayed job scheduler...');
    setInterval(async () => {
      try {
        const now = Date.now();
        const jobs = await this.redis.zrangebyscore(`${this.queueName}:delayed`, 0, now);

        if (jobs.length > 0) {
          console.log(`[Scheduler] Re-enqueuing ${jobs.length} jobs...`);
          for (const jobString of jobs) {
            const jobData = JSON.parse(jobString);

            await this.addJob(jobData);

            await this.redis.zrem(`${this.queueName}:delayed`, jobString);
          }
        }
      } catch (err) {
        console.error('[Scheduler] Error moving delayed jobs:', err);
      }
    }, 1000);
  }
}

module.exports = QueueManager;
