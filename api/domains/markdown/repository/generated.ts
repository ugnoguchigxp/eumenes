import type { Database } from "bun:sqlite";
import type { GeneratedInput, GeneratedReceipt } from "../contracts/generated";

export type GeneratedRow = {
	id: string;
	digest: string;
	input_json: string;
	binding: string | null;
	source_id: string;
	state: "pending" | "settled" | "cancelled";
	local_json: string;
	archive_json: string;
	job_id: string;
	created_at: number;
};
export const generatedRow = (db: Database, id: string) =>
	db
		.query("SELECT * FROM markdown_generated WHERE id=?")
		.get(id) as GeneratedRow | null;
export const generatedValue = (r: GeneratedRow): GeneratedInput =>
	JSON.parse(r.input_json);
export function generatedReceipt(r: GeneratedRow): GeneratedReceipt {
	const input = generatedValue(r);
	return {
		id: r.id,
		title: input.title,
		path: input.path,
		state: r.state,
		local: JSON.parse(r.local_json),
		archive: JSON.parse(r.archive_json),
	};
}
