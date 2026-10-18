import type { Database } from "bun:sqlite";
import type { ImageImportView } from "../contracts";

export type ImportRow = {
	request_id: string;
	principal: string;
	connection: string;
	original_digest: string;
	bytes: Uint8Array | null;
	attempted: number;
	view_json: string;
	expires_at: number;
};
export const findImport = (db: Database, id: string, principal: string) =>
	db
		.query("SELECT * FROM image_imports WHERE request_id=? AND principal=?")
		.get(id, principal) as ImportRow | null;
export function insertImport(
	db: Database,
	input: {
		id: string;
		principal: string;
		connection: string;
		digest: string;
		bytes: Uint8Array;
		view: ImageImportView;
	},
) {
	db.query("UPDATE image_imports SET bytes=NULL WHERE expires_at<=?").run(
		Date.now(),
	);
	const capacity = db
		.query(
			"SELECT COALESCE(SUM(length(bytes)),0) AS size FROM image_imports WHERE principal=?",
		)
		.get(input.principal) as { size: number };
	if (capacity.size + input.bytes.length > 64 * 1024 * 1024)
		throw new Error("image_import_capacity");
	db.query(
		"INSERT INTO image_imports(request_id,principal,connection,original_digest,bytes,view_json,expires_at) VALUES(?,?,?,?,?,?,?)",
	).run(
		input.id,
		input.principal,
		input.connection,
		input.digest,
		input.bytes,
		JSON.stringify(input.view),
		input.view.expiresAt,
	);
}
export function updateImport(
	db: Database,
	id: string,
	principal: string,
	view: ImageImportView,
	attempted?: boolean,
) {
	const terminal = ["succeeded", "deleted", "failed", "expired"].includes(
		view.status,
	);
	db.query(
		"UPDATE image_imports SET view_json=?, expires_at=?, attempted=CASE WHEN ? THEN 1 ELSE attempted END, bytes=CASE WHEN ? THEN NULL ELSE bytes END WHERE request_id=? AND principal=?",
	).run(
		JSON.stringify(view),
		view.expiresAt,
		Number(!!attempted),
		Number(terminal),
		id,
		principal,
	);
	return view;
}
