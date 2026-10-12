const express = require('express');
const { jobs, validateSchedule } = require('@scheduler/core');
const Controller = require('../utils/Controller');
const AppError = require('../utils/AppError');

module.exports = () => {
  const router = express.Router();

  router.get('/', Controller(async (req, res) => {
    res.json({ schedules: await jobs.listSchedules() });
  }));

  // PUT = create or replace; the name is the schedule's identity.
  router.put('/:name', Controller(async (req, res) => {
    const spec = validateSchedule({ ...req.body, name: req.params.name });
    res.json(await jobs.upsertSchedule(spec));
  }));

  router.delete('/:name', Controller(async (req, res) => {
    if (!(await jobs.deleteSchedule(req.params.name))) throw new AppError(404, 'Schedule not found');
    res.status(204).end();
  }));

  return router;
};
