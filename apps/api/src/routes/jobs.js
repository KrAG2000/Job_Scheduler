const express = require('express');
const { jobs, validateJob, STATES, metrics: { metrics } } = require('@scheduler/core');
const Controller = require('../utils/Controller');
const AppError = require('../utils/AppError');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BATCH = 500;

const requireUuid = (id) => {
  if (!UUID_RE.test(id)) throw new AppError(404, 'Job not found');
};

module.exports = ({ rateLimit, backpressure }) => {
  const router = express.Router();

  router.post(
    '/',
    rateLimit(),
    backpressure.middleware((req) => [req.body?.queue || 'default']),
    Controller(async (req, res) => {
      const spec = validateJob(req.body, { idempotencyKey: req.get('idempotency-key') });
      const { job, created } = await jobs.createJob(spec);
      if (created) metrics.jobsCreated.inc({ queue: job.queue, type: job.type });
      // 200 for an idempotent replay of an earlier request, 201 for a new job.
      res.status(created ? 201 : 200).json(job);
    }),
  );

  router.post(
    '/batch',
    rateLimit({ cost: (req) => (Array.isArray(req.body?.jobs) ? Math.max(req.body.jobs.length, 1) : 1) }),
    backpressure.middleware((req) => [...new Set((req.body?.jobs || []).map((j) => j?.queue || 'default'))]),
    Controller(async (req, res) => {
      const list = req.body?.jobs;
      if (!Array.isArray(list) || list.length === 0 || list.length > MAX_BATCH) {
        throw new AppError(400, `jobs must be an array of 1-${MAX_BATCH} items`);
      }
      const specs = list.map((body, i) => {
        try {
          return validateJob(body);
        } catch (err) {
          throw new AppError(400, `jobs[${i}]: ${err.message}`);
        }
      });
      const results = await jobs.createJobs(specs);
      for (const r of results) if (r.created) metrics.jobsCreated.inc({ queue: r.job.queue, type: r.job.type });
      res.status(201).json({ jobs: results.map((r) => ({ id: r.job.id, status: r.job.status, created: r.created })) });
    }),
  );

  router.get('/', Controller(async (req, res) => {
    const { status, queue, type, cursor } = req.query;
    if (status && !Object.values(STATES).includes(status)) {
      throw new AppError(400, `status must be one of ${Object.values(STATES).join(', ')}`);
    }
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 50;
    if (Number.isNaN(limit)) throw new AppError(400, 'limit must be a number');
    res.json(await jobs.listJobs({ status, queue, type, limit, cursor }));
  }));

  router.get('/:id', Controller(async (req, res) => {
    requireUuid(req.params.id);
    const job = await jobs.getJob(req.params.id);
    if (!job) throw new AppError(404, 'Job not found');
    res.json(job);
  }));

  router.post('/:id/cancel', Controller(async (req, res) => {
    requireUuid(req.params.id);
    const { job, cancelled } = await jobs.cancelJob(req.params.id);
    if (!job) throw new AppError(404, 'Job not found');
    if (!cancelled) throw new AppError(409, `Job is already ${job.status}`);
    res.json(job);
  }));

  router.post('/:id/replay', Controller(async (req, res) => {
    requireUuid(req.params.id);
    const { job, replayed } = await jobs.replayJob(req.params.id);
    if (!job) throw new AppError(404, 'Job not found');
    if (!replayed) throw new AppError(409, `Only DEAD or CANCELLED jobs can be replayed (job is ${job.status})`);
    res.json(job);
  }));

  return router;
};
