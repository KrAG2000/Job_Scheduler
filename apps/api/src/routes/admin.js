const express = require('express');
const { jobs, config, withTimeout } = require('@scheduler/core');
const Controller = require('../utils/Controller');
const AppError = require('../utils/AppError');

module.exports = ({ queueManager }) => {
  const router = express.Router();

  // Queue depth per stream plus job counts per status.
  router.get('/queues', Controller(async (req, res) => {
    const [streams, counts, outbox] = await Promise.all([
      withTimeout(queueManager.streamStats(), 2000, 'queue stats'),
      jobs.countByStatus(),
      jobs.outboxBacklog(),
    ]);
    const queues = {};
    for (const q of config.queues) queues[q] = { lag: 0, pending: 0, delayed: 0, dlq: 0, byLane: {}, jobs: {} };
    for (const s of streams) {
      const q = queues[s.queue];
      if (!q) continue;
      for (const k of ['lag', 'pending', 'delayed', 'dlq']) q[k] += s[k];
      q.byLane[s.lane] = (q.byLane[s.lane] || 0) + s.lag + s.pending;
    }
    for (const c of counts) if (queues[c.queue]) queues[c.queue].jobs[c.status] = c.count;
    res.json({ outbox, queues });
  }));

  // Bulk re-run of dead-lettered jobs, optionally filtered.
  router.post('/dlq/replay', Controller(async (req, res) => {
    const { queue, type, limit = 100 } = req.body || {};
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new AppError(400, 'limit must be 1-1000');
    const ids = await jobs.replayDead({ queue, type, limit });
    res.json({ replayed: ids.length, jobIds: ids });
  }));

  return router;
};
