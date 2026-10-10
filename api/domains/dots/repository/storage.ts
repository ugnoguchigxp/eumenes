// All retained bodies share a bounded budget. Trigger accounting avoids scanning payloads on each report.
const columns: Record<string, string[]> = {
	dots_commands: ["data_json"],
	dots_reports: ["data_json", "receipt_json"],
	dots_dialogue_receipts: ["receipt_json"],
};
const size = (columns: string[], prefix: string) =>
	columns.map((c) => `length(CAST(${prefix}.${c} AS BLOB))`).join("+");
// Reserve 8 MiB for bounded stop commands and sanitized stop receipts.
const limit = (table: string) =>
	table === "dots_commands"
		? "CASE WHEN (json_extract(NEW.data_json,'$.kind')='stop' OR NEW.state='superseded') THEN 67108864 ELSE 58720256 END"
		: table === "dots_reports"
			? "CASE WHEN json_extract(NEW.data_json,'$.kind')='stopped' THEN 67108864 ELSE 58720256 END"
			: "58720256";
export const storageMigration =
	`CREATE TABLE dots_storage(id INTEGER PRIMARY KEY CHECK(id=1),bytes INTEGER NOT NULL);INSERT INTO dots_storage VALUES(1,0);` +
	Object.entries(columns)
		.map(
			([table, cols]) => `
CREATE TRIGGER ${table}_budget_insert BEFORE INSERT ON ${table} WHEN NOT EXISTS(SELECT 1 FROM ${table} WHERE ${table === "dots_dialogue_receipts" ? "run_id=NEW.run_id" : "id=NEW.id"}) AND (SELECT bytes FROM dots_storage WHERE id=1)+${size(cols, "NEW")}>(${limit(table)}) BEGIN SELECT RAISE(ABORT,'dots_capacity');END;
CREATE TRIGGER ${table}_budget_update BEFORE UPDATE ON ${table} WHEN (${size(cols, "NEW")})>(${size(cols, "OLD")}) AND (SELECT bytes FROM dots_storage WHERE id=1)-(${size(cols, "OLD")})+${size(cols, "NEW")}>(${limit(table)}) BEGIN SELECT RAISE(ABORT,'dots_capacity');END;
CREATE TRIGGER ${table}_storage_insert AFTER INSERT ON ${table} BEGIN UPDATE dots_storage SET bytes=bytes+${size(cols, "NEW")} WHERE id=1;END;
CREATE TRIGGER ${table}_storage_update AFTER UPDATE ON ${table} BEGIN UPDATE dots_storage SET bytes=bytes-(${size(cols, "OLD")})+${size(cols, "NEW")} WHERE id=1;END;
CREATE TRIGGER ${table}_storage_delete AFTER DELETE ON ${table} BEGIN UPDATE dots_storage SET bytes=bytes-(${size(cols, "OLD")}) WHERE id=1;END;
`,
		)
		.join("\n");
