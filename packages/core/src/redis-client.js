const Redis = require('ioredis');
const config = require('./config');
const logger = require('./logger');
const { defineScripts } = require('./scripts');

const createRedis = (name = 'main', overrides = {}) => {
  const { redis } = config;
  const options = { maxRetriesPerRequest: null, ...overrides };

  let client;
  if (redis.sentinels.length > 0) {
    client = new Redis({ ...options, sentinels: redis.sentinels, name: redis.masterName });
  } else if (redis.url) {
    client = new Redis(redis.url, options);
  } else {
    client = new Redis({ ...options, host: redis.host, port: redis.port });
  }

  client.on('error', (err) => logger.error({ err, conn: name }, 'redis error'));
  client.on('ready', () => logger.debug({ conn: name }, 'redis ready'));
  defineScripts(client);
  return client;
};

let shared;
const getRedis = () => {
  if (!shared) shared = createRedis('shared');
  return shared;
};

const closeRedis = async () => {
  if (shared) {
    await shared.quit();
    shared = undefined;
  }
};

module.exports = { createRedis, getRedis, closeRedis };
