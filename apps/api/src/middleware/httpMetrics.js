const { metrics } = require('@scheduler/core').metrics;

const httpMetrics = (service) => (req, res, next) => {
  const end = metrics.httpDuration.startTimer();
  res.on('finish', () => {
    // Use the matched route pattern, not the raw URL, to keep label cardinality bounded.
    const route = req.route ? `${req.baseUrl}${req.route.path}` : 'unmatched';
    end({ service, method: req.method, route });
    metrics.httpRequests.inc({ service, method: req.method, route, status: res.statusCode });
  });
  next();
};

module.exports = httpMetrics;
