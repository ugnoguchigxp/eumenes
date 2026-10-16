import type { Migration } from "../../../infrastructure/sqlite";
import { pauseResumeMigration } from "./pause-migration";

export const migration = `
CREATE TABLE timers (
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
  state TEXT NOT NULL CHECK(state IN ('active','elapsed','cancelled')),
  revision INTEGER NOT NULL DEFAULT 0,
  cancel_epoch INTEGER NOT NULL DEFAULT 0,
  schedule_id TEXT,
  expiry_job_id TEXT,
  dispatch_generation INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  body_expired INTEGER NOT NULL DEFAULT 0,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  CHECK(due_at_ms = started_at_ms + duration_seconds * 1000),
  CHECK((state = 'cancelled') = (cancelled_at_ms IS NOT NULL))
);
CREATE UNIQUE INDEX timers_origin ON timers(scope, origin_key)
  WHERE origin_key IS NOT NULL;
CREATE INDEX timers_due ON timers(state, due_at_ms, id);
CREATE INDEX timers_conversation ON timers(scope, conversation_id, created_at_ms, id);

CREATE TABLE timer_operations (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  request_id TEXT NOT NULL,
  issued_at_ms INTEGER NOT NULL,
  input_digest TEXT NOT NULL,
  operation TEXT NOT NULL CHECK(operation IN ('start','list','cancel')),
  timer_id TEXT,
  origin_key TEXT,
  receipt_json TEXT,
  receipt_digest TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  expired_at_ms INTEGER,
  UNIQUE(scope, request_id)
);

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
  UNIQUE(timer_id, generation)
);
CREATE INDEX timer_notifications_pending
  ON timer_notifications(scope, status, due_at_ms, id);
`;

/** Named migrations of this domain; the SQL above is frozen once deployed. */
export const migrations: readonly Migration[] = [
	{ id: "timers/0001-init", sql: migration },
	{
		id: "timers/0002-retention-indexes",
		after: ["timers/0001-init"],
		sql: `
CREATE INDEX timer_operations_live ON timer_operations(created_at_ms, id) WHERE receipt_json IS NOT NULL;
CREATE INDEX timer_operations_expired ON timer_operations(expired_at_ms, id) WHERE expired_at_ms IS NOT NULL;
CREATE INDEX timer_operations_timer ON timer_operations(timer_id) WHERE timer_id IS NOT NULL;
CREATE INDEX timer_operations_scope_kind ON timer_operations(scope, operation);
CREATE INDEX timers_retention ON timers(body_expired, updated_at_ms, id) WHERE state!='active';
`,
	},
	{
		id: "timers/0003-pause-resume",
		after: ["timers/0002-retention-indexes"],
		sql: pauseResumeMigration,
	},
];
