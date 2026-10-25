// Append-only migration: preserve deployed SQL and every command sequence/foreign key.
const budget = (table: string) => {
	const size = (row: string) =>
		`(length(CAST(${row}.data_json AS BLOB))${table === "dots_messages" ? `+coalesce(json_extract(${row}.data_json,'$.bodyBytes'),0)` : ""})`;
	return `
CREATE TRIGGER ${table}_budget_insert BEFORE INSERT ON ${table} WHEN NOT EXISTS(SELECT 1 FROM ${table} WHERE id=NEW.id) AND (SELECT bytes FROM dots_storage WHERE id=1)+${size("NEW")}>58720256 BEGIN SELECT RAISE(ABORT,'dots_capacity');END;
CREATE TRIGGER ${table}_budget_update BEFORE UPDATE ON ${table} WHEN ${size("NEW")}>${size("OLD")} AND (SELECT bytes FROM dots_storage WHERE id=1)-${size("OLD")}+${size("NEW")}>58720256 BEGIN SELECT RAISE(ABORT,'dots_capacity');END;
CREATE TRIGGER ${table}_storage_insert AFTER INSERT ON ${table} BEGIN UPDATE dots_storage SET bytes=bytes+${size("NEW")} WHERE id=1;END;
CREATE TRIGGER ${table}_storage_update AFTER UPDATE ON ${table} BEGIN UPDATE dots_storage SET bytes=bytes-${size("OLD")}+${size("NEW")} WHERE id=1;END;
CREATE TRIGGER ${table}_storage_delete AFTER DELETE ON ${table} BEGIN UPDATE dots_storage SET bytes=bytes-${size("OLD")} WHERE id=1;END;
`;
};
export function messagingMigration(commandTriggers: string) {
	return `
CREATE TABLE dots_messaging_settings(id TEXT PRIMARY KEY REFERENCES dots_connections(id),data_json TEXT NOT NULL);
CREATE TABLE dots_message_conversations(id TEXT PRIMARY KEY,connection_ref TEXT NOT NULL REFERENCES dots_connections(id),request_id TEXT NOT NULL UNIQUE,conversation_id TEXT NOT NULL,data_json TEXT NOT NULL);
CREATE TABLE dots_messages(id TEXT PRIMARY KEY,thread_id TEXT NOT NULL REFERENCES dots_message_conversations(id),request_id TEXT NOT NULL UNIQUE,sequence INTEGER NOT NULL,data_json TEXT NOT NULL,UNIQUE(thread_id,sequence));
CREATE TABLE dots_message_replies(id TEXT PRIMARY KEY,message_id TEXT NOT NULL UNIQUE REFERENCES dots_messages(id),thread_id TEXT NOT NULL REFERENCES dots_message_conversations(id),data_json TEXT NOT NULL);
CREATE TABLE dots_message_cancellations(id TEXT PRIMARY KEY,message_id TEXT NOT NULL REFERENCES dots_messages(id),data_json TEXT NOT NULL);
CREATE TEMP TABLE dots_command_sequence_backup(value INTEGER);
INSERT INTO dots_command_sequence_backup SELECT seq FROM sqlite_sequence WHERE name='dots_commands';
CREATE TABLE dots_commands_next(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,task_id TEXT,message_id TEXT REFERENCES dots_messages(id),connection_ref TEXT NOT NULL REFERENCES dots_connections(id),state TEXT NOT NULL,data_json TEXT NOT NULL,CHECK((task_id IS NOT NULL AND message_id IS NULL AND json_extract(data_json,'$.kind')!='message') OR (task_id IS NULL AND message_id IS NOT NULL AND json_extract(data_json,'$.kind')='message')));
INSERT INTO dots_commands_next(seq,id,task_id,connection_ref,state,data_json) SELECT seq,id,task_id,connection_ref,state,data_json FROM dots_commands;
CREATE TABLE dots_deliveries_next(id TEXT PRIMARY KEY,command_id TEXT NOT NULL UNIQUE REFERENCES dots_commands_next(id),data_json TEXT NOT NULL);
INSERT INTO dots_deliveries_next SELECT * FROM dots_deliveries;
DROP TABLE dots_deliveries;
DROP TRIGGER dots_commands_budget_insert;
DROP TRIGGER dots_commands_budget_update;
DROP TRIGGER dots_commands_storage_insert;
DROP TRIGGER dots_commands_storage_update;
DROP TRIGGER dots_commands_storage_delete;
DROP TABLE dots_commands;
ALTER TABLE dots_commands_next RENAME TO dots_commands;
ALTER TABLE dots_deliveries_next RENAME TO dots_deliveries;
INSERT INTO sqlite_sequence(name,seq) SELECT 'dots_commands',max(value) FROM dots_command_sequence_backup HAVING max(value) IS NOT NULL AND NOT EXISTS(SELECT 1 FROM sqlite_sequence WHERE name='dots_commands');
UPDATE sqlite_sequence SET seq=max(seq,coalesce((SELECT max(value) FROM dots_command_sequence_backup),0)) WHERE name='dots_commands';
DROP TABLE dots_command_sequence_backup;
CREATE INDEX dots_commands_pending ON dots_commands(connection_ref,state,seq);
CREATE INDEX dots_commands_task ON dots_commands(task_id,seq);
CREATE INDEX dots_commands_message ON dots_commands(message_id);
${commandTriggers}
${["dots_messaging_settings", "dots_message_conversations", "dots_messages", "dots_message_replies", "dots_message_cancellations"].map(budget).join("\n")}
`;
}
