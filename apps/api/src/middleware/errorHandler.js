const { logger } = require('@scheduler/core');

// eslint-disable-next-line no-unused-vars
const errorHandler = (err, req, res, next) => {
  // body-parser errors: malformed JSON / payload too large
  if (err.type === 'entity.parse.failed') err.statusCode = 400;
  if (err.type === 'entity.too.large') err.statusCode = 413;

  const statusCode = err.statusCode || err.status || 500;
  if (statusCode >= 500) {
    logger.error({ err, method: req.method, url: req.originalUrl }, 'request failed');
  }

  res.status(statusCode).json({
    error: statusCode >= 500 ? 'Internal Server Error' : err.message,
  });
};

module.exports = errorHandler;
