import type { Database } from "bun:sqlite";
import type { Purpose, Settings } from "../../settings/contracts";
export const migration = `
CREATE TABLE inference_requests (id TEXT PRIMARY KEY,subject TEXT NOT NULL,purpose TEXT NOT NULL,snapshot TEXT NOT NULL,deadline INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'pending',UNIQUE(subject,purpose));
CREATE TABLE inference_attempts (id TEXT PRIMARY KEY,request_id TEXT NOT NULL REFERENCES inference_requests(id),source TEXT NOT NULL,connection_id TEXT,resource_id TEXT,model TEXT,status TEXT NOT NULL,reason TEXT,started INTEGER NOT NULL,ended INTEGER,accepted INTEGER NOT NULL DEFAULT 0,input_tokens INTEGER,output_tokens INTEGER);
CREATE TABLE inference_probes (id TEXT PRIMARY KEY,target TEXT NOT NULL,status TEXT NOT NULL,error TEXT,revision INTEGER NOT NULL,created INTEGER NOT NULL);
`;
export const parentsMigration = `ALTER TABLE inference_requests ADD COLUMN parents TEXT NOT NULL DEFAULT '[]';`;
export const diagnosticsMigration = `ALTER TABLE inference_attempts ADD COLUMN provider_details TEXT NOT NULL DEFAULT '[]';`;
export const controlMigration = `
ALTER TABLE inference_requests ADD COLUMN mode TEXT NOT NULL DEFAULT 'answer';
ALTER TABLE inference_requests ADD COLUMN output_limit INTEGER;
ALTER TABLE inference_requests ADD COLUMN context_policy TEXT NOT NULL DEFAULT 'legacy';
`;
export const backgroundControlMigration = `CREATE TABLE inference_background_controls (
 request_id TEXT PRIMARY KEY REFERENCES inference_requests(id), binding TEXT NOT NULL
);`;
export interface RequestRow {
	id: string;
	subject: string;
	purpose: Purpose;
	snapshot: Settings;
	deadline: number;
	status: string;
	parents: string[];
	mode: "answer" | "control";
	outputLimit: number | null;
	contextPolicy: "legacy" | "exact";
}
export function get(db: Database, id: string): RequestRow | null {
	const row = db
		.query("SELECT * FROM inference_requests WHERE id=?")
		.get(id) as
		| (Omit<RequestRow, "snapshot" | "parents"> & {
				snapshot: string;
				parents: string;
				output_limit?: number | null;
				context_policy?: "legacy" | "exact";
		  })
		| null;
	return row
		? {
				...row,
				snapshot: JSON.parse(row.snapshot) as Settings,
				parents: JSON.parse(row.parents) as string[],
				mode: row.mode ?? "answer",
				outputLimit: row.output_limit ?? null,
				contextPolicy: row.context_policy ?? "legacy",
			}
		: null;
}
