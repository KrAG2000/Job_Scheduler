// SCHEDULED --(run_at reached, relay)--> QUEUED --(worker)--> RUNNING --> SUCCEEDED
//                                          ^                    |
//                                          |                    +--(error, attempts left)--> RETRYING --(backoff)--+
//                                          +----------------------------------------------------------------------+
//                                                               +--(error, no attempts left / non-retryable)--> DEAD
// Any non-terminal state --(cancel)--> CANCELLED.   DEAD / CANCELLED --(replay)--> QUEUED
const STATES = Object.freeze({
  SCHEDULED: 'SCHEDULED',
  QUEUED: 'QUEUED',
  RUNNING: 'RUNNING',
  RETRYING: 'RETRYING',
  SUCCEEDED: 'SUCCEEDED',
  DEAD: 'DEAD',
  CANCELLED: 'CANCELLED',
});

const ACTIVE = [STATES.SCHEDULED, STATES.QUEUED, STATES.RUNNING, STATES.RETRYING];
const TERMINAL = [STATES.SUCCEEDED, STATES.DEAD, STATES.CANCELLED];

module.exports = { STATES, ACTIVE, TERMINAL };
