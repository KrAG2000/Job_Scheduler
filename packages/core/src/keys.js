const config = require('./config');

// FNV-1a: cheap, stable string hash for spreading jobs across partitions.
const hash = (str) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
};

const partitionFor = (jobId, partitions = config.partitions) => hash(jobId) % partitions;

// The {hash tag} makes a stream, its delayed set and its DLQ live in the same Redis
// Cluster slot, so the Lua scripts that touch all three stay valid in cluster mode.
const base = (queue, lane, partition, prefix = config.keyPrefix) => `${prefix}:{${queue}:${lane}:${partition}}`;

const streamKeys = (queue, lane, partition, prefix) => {
  const b = base(queue, lane, partition, prefix);
  return { queue, lane, partition, stream: `${b}:stream`, delayed: `${b}:delayed`, dlq: `${b}:dlq` };
};

const keysForJob = (job, opts = {}) =>
  streamKeys(job.queue, job.priority, partitionFor(job.id, opts.partitions), opts.prefix);

// Ordered high -> low lane so a fetcher can honour strict priority.
const allStreams = ({ queues = config.queues, partitions = config.partitions, prefix } = {}) => {
  const out = [];
  for (const lane of config.lanes) {
    for (const queue of queues) {
      for (let p = 0; p < partitions; p++) out.push(streamKeys(queue, lane, p, prefix));
    }
  }
  return out;
};

module.exports = { hash, partitionFor, streamKeys, keysForJob, allStreams };
