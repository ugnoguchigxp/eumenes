import type { Database } from "bun:sqlite";
export type ManagementRow = {
	id: string;
	binding: string;
	namespace: string;
	command_json: string;
	expected_json: string;
	state: "unknown" | "applied" | "confirmed" | "failed" | "conflict";
	code: string | null;
	removed_json: string;
	created_at: number;
};
export const managementRow = (db: Database, id: string) =>
	db
		.query("SELECT * FROM markdown_operations WHERE id=?")
		.get(id) as ManagementRow | null;
export function assertLibraryIdle(
	db: Database,
	binding: string | null,
	namespace: string | null,
) {
	if (
		binding &&
		namespace &&
		db
			.query(
				"SELECT id FROM markdown_operations WHERE binding=? AND namespace=? AND state='unknown' LIMIT 1",
			)
			.get(binding, namespace)
	)
		throw new Error("markdown_management_pending");
}
