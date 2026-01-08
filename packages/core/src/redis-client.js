const Redis = require('ioredis');

class RedisClient {
  constructor() {
    this.client = new Redis({
      host: process.env.REDIS_HOST || 'localhost',
      port: process.env.REDIS_PORT || 6379,
    });

    this.client.on('error', (err) => console.error('Redis Client Error', err));
    this.client.on('connect', () => console.log('Redis Client Connected'));
  }

  getClient() {
    return this.client;
  }

  async disconnect() {
    await this.client.quit();
  }
}

const redisClient = new RedisClient();
module.exports = redisClient;
