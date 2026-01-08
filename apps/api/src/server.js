require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const { QueueManager, db } = require('@scheduler/core');

const app = express();
const port = process.env.API_PORT || 3000;

app.use(cors());
app.use(bodyParser.json());

const queue = new QueueManager('jobs_stream');

db.initDB();

app.post('/jobs', async (req, res) => {
  const { type, payload } = req.body;

  if (!type || !payload) {
    return res.status(400).json({ error: 'Missing type or payload' });
  }

  const jobId = uuidv4();

  try {
    await db.pool.query(
      'INSERT INTO jobs (id, status, payload) VALUES ($1, $2, $3)',
      [jobId, 'PENDING', JSON.stringify({ type, payload })]
    );

    const redisId = await queue.addJob({ jobId, type, payload });

    await db.pool.query(
      'UPDATE jobs SET redis_id = $1 WHERE id = $2',
      [redisId, jobId]
    );

    res.status(201).json({ jobId, status: 'PENDING' });
  } catch (err) {
    console.error('Error submitting job:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.get('/jobs/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const result = await db.pool.query('SELECT * FROM jobs WHERE id = $1', [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Job not found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error fetching job:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.listen(port, () => {
  console.log(`API Server running on port ${port}`);
});
