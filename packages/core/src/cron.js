const { CronExpressionParser } = require('cron-parser');
const { ValidationError } = require('./errors');

const nextRun = (expression, timezone = 'UTC', after = new Date()) =>
  CronExpressionParser.parse(expression, { currentDate: after, tz: timezone }).next().toDate();

const validateCron = (expression, timezone) => {
  try {
    return nextRun(expression, timezone);
  } catch (err) {
    throw new ValidationError(`Invalid cron expression or timezone: ${err.message}`);
  }
};

module.exports = { nextRun, validateCron };
