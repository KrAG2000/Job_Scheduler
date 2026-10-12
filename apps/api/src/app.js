const express = require('express');
const cors = require('cors');
const { config, db, getRedis, withTimeout, metrics: { register } } = require('@scheduler/core');
const errorHandler = require('./middleware/errorHandler');
const auth = require('./middleware/auth');
const rateLimit = require('./middleware/rateLimit');
const httpMetrics = require('./middleware/httpMetrics');
const jobsRoutes = require('./routes/jobs');
const schedulesRoutes = require('./routes/schedules');
const adminRoutes = require('./routes/admin');
const AppError = require('./utils/AppError');

const createApp = ({ queueManager, backpressure, apiKeys = config.api.apiKeys }) => {
  const app = express();
  app.set('trust proxy', config.api.trustProxy);
  app.disable('x-powered-by');

  app.use(httpMetrics('api'));
  app.use(cors());
  app.use(express.json({ limit: config.api.bodyLimit }));

  // Unauthenticated operational endpoints.
  app.get('/healthz', (req, res) => res.json({ status: 'ok' }));
  app.get('/readyz', async (req, res) => {
    try {
      await withTimeout(Promise.all([db.pool.query('SELECT 1'), getRedis().ping()]), 1000, 'readiness check');
      res.json({ status: 'ready' });
    } catch (err) {
      res.status(503).json({ status: 'not ready', error: err.message });
    }
  });
  app.get('/metrics', async (req, res) => {
    res.set('Content-Type', register.contentType);
    res.end(await register.metrics());
  });

  app.use(auth(apiKeys));
  app.use('/jobs', jobsRoutes({ rateLimit, backpressure }));
  app.use('/schedules', schedulesRoutes());
  app.use('/', adminRoutes({ queueManager }));

  app.use((req, res, next) => next(new AppError(404, 'Not found')));
  app.use(errorHandler);
  return app;
};

module.exports = createApp;
