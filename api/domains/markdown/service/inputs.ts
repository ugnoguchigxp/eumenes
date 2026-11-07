import type { Database } from "bun:sqlite";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import { stageInput } from "../contracts";

export function staged(db: Database, id: string) {
	const value = db
		.query(
			"SELECT content_json,markdown,expires_at FROM markdown_inputs WHERE id=?",
		)
		.get(id) as {
		content_json: string;
		markdown: string | null;
		expires_at: number;
	} | null;
	if (!value || value.expires_at < Date.now())
		throw new Error("markdown_input_expired");
	return value;
}
export const stageDocument = (store: SqliteStore) => async (raw: unknown) => {
	const input = stageInput.parse(raw),
		id = crypto.randomUUID();
	await store.write((db) => {
		db.query("DELETE FROM markdown_inputs WHERE expires_at<?").run(Date.now());
		if (
			(
				db.query("SELECT count(*) AS n FROM markdown_inputs").get() as {
					n: number;
				}
			).n >= 20
		)
			throw new Error("markdown_input_full");
		db.query("INSERT INTO markdown_inputs VALUES(?,?,?,?)").run(
			id,
			JSON.stringify(input.document),
			input.markdown ?? null,
			Date.now() + 3600000,
		);
	});
	return { id };
};
