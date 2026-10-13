/** Append-only schema upgrade. Existing timers, operation receipts and notification FKs survive. */
export const pauseResumeMigration = `
-- Preserve the child rows without dropping a referenced parent table.
CREATE TABLE timer_notifications_backup AS SELECT * FROM timer_notifications;
DROP TABLE timer_notifications;
CREATE TABLE timers_next (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  conversation_id TEXT,
  origin_run_id TEXT,
  origin_message_id TEXT,
  origin_key TEXT,
  label TEXT NOT NULL,
  duration_seconds INTEGER NOT NULL CHECK(duration_seconds BETWEEN 1 AND 86400),
  started_at_ms INTEGER NOT NULL,
  due_at_ms INTEGER NOT NULL,
  cancelled_at_ms INTEGER,
  terminal_at_ms INTEGER,
  state TEXT NOT NULL CHECK(state IN ('active','paused','elapsed','cancelled')),
  revision INTEGER NOT NULL DEFAULT 0,
  cancel_epoch INTEGER NOT NULL DEFAULT 0,
  schedule_id TEXT,
  expiry_job_id TEXT,
  dispatch_generation INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  body_expired INTEGER NOT NULL DEFAULT 0,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  paused_at_ms INTEGER,
  paused_total_ms INTEGER NOT NULL DEFAULT 0 CHECK(paused_total_ms>=0),
  paused_remaining_ms INTEGER CHECK(paused_remaining_ms>=0 AND paused_remaining_ms<=duration_seconds*1000),
  CHECK(due_at_ms = started_at_ms + duration_seconds*1000 + paused_total_ms),
  CHECK((state = 'cancelled') = (cancelled_at_ms IS NOT NULL)),
  CHECK((state = 'paused') = (paused_at_ms IS NOT NULL)),
  CHECK(state != 'paused' OR paused_remaining_ms>0)
);
INSERT INTO timers_next (
  id,scope,conversation_id,origin_run_id,origin_message_id,origin_key,label,duration_seconds,
  started_at_ms,due_at_ms,cancelled_at_ms,terminal_at_ms,state,revision,cancel_epoch,schedule_id,
  expiry_job_id,dispatch_generation,error_code,body_expired,created_at_ms,updated_at_ms
) SELECT id,scope,conversation_id,origin_run_id,origin_message_id,origin_key,label,duration_seconds,
  started_at_ms,due_at_ms,cancelled_at_ms,terminal_at_ms,state,revision,cancel_epoch,schedule_id,
  expiry_job_id,dispatch_generation,error_code,body_expired,created_at_ms,updated_at_ms FROM timers;
DROP TABLE timers;
ALTER TABLE timers_next RENAME TO timers;
CREATE UNIQUE INDEX timers_origin ON timers(scope,origin_key) WHERE origin_key IS NOT NULL;
CREATE INDEX timers_due ON timers(state,due_at_ms,id);
CREATE INDEX timers_conversation ON timers(scope,conversation_id,created_at_ms,id);
CREATE INDEX timers_retention ON timers(body_expired,updated_at_ms,id) WHERE state IN ('elapsed','cancelled');

CREATE TABLE timer_notifications (
  id TEXT PRIMARY KEY,
  timer_id TEXT NOT NULL REFERENCES timers(id),
  scope TEXT NOT NULL,
  generation INTEGER NOT NULL,
  due_at_ms INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','claimed','played','silent','dismissed')),
  reason TEXT,
  revision INTEGER NOT NULL DEFAULT 0,
  claim_id TEXT,
  claim_request_id TEXT,
  client_id TEXT,
  lease_until_ms INTEGER,
  played_at_ms INTEGER,
  dismissed_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  UNIQUE(timer_id,generation)
);
INSERT INTO timer_notifications SELECT * FROM timer_notifications_backup;
DROP TABLE timer_notifications_backup;
CREATE INDEX timer_notifications_pending ON timer_notifications(scope,status,due_at_ms,id);

CREATE TABLE timer_operations_next (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  request_id TEXT NOT NULL,
  issued_at_ms INTEGER NOT NULL,
  input_digest TEXT NOT NULL,
  operation TEXT NOT NULL CHECK(operation IN ('start','list','cancel','pause','resume')),
  timer_id TEXT,
  origin_key TEXT,
  receipt_json TEXT,
  receipt_digest TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  expired_at_ms INTEGER,
  UNIQUE(scope,request_id)
);
INSERT INTO timer_operations_next SELECT * FROM timer_operations;
DROP TABLE timer_operations;
ALTER TABLE timer_operations_next RENAME TO timer_operations;
CREATE INDEX timer_operations_live ON timer_operations(created_at_ms,id) WHERE receipt_json IS NOT NULL;
CREATE INDEX timer_operations_expired ON timer_operations(expired_at_ms,id) WHERE expired_at_ms IS NOT NULL;
CREATE INDEX timer_operations_timer ON timer_operations(timer_id) WHERE timer_id IS NOT NULL;
CREATE INDEX timer_operations_scope_kind ON timer_operations(scope,operation);
`;
