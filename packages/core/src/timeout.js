// ioredis queues commands while disconnected instead of failing them, so anything on a
// request path must bound its wait or one Redis outage stalls every HTTP request.
const withTimeout = (promise, ms, label = 'operation') => {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};

module.exports = { withTimeout };
