import { readFileSync } from "node:fs";
import { readApiToken } from "../api/infrastructure/auth-config";
import { worldDocumentInput } from "../api/domains/world/contracts/documents";

// Explicit input only. Does not discover batches, read a writer connection, or clear any data.
const path = process.argv[2];
if (!path)
	throw new Error(
		"usage: bun scripts/world-documents-import.ts <jsonl> [--run]",
	);
const records = readFileSync(path, "utf8")
	.trimEnd()
	.split("\n")
	.map((line) => worldDocumentInput.parse(JSON.parse(line)));
if (new Set(records.map((r) => r.id)).size !== records.length)
	throw new Error("duplicate_document_id");
if (!process.argv.includes("--run")) {
	console.log(
		JSON.stringify({ mode: "validated_only", count: records.length }),
	);
} else {
	const url = process.env.EUMENES_URL ?? "http://127.0.0.1:8787";
	const headers = {
		Authorization: `Bearer ${readApiToken(process.env)}`,
		"Content-Type": "application/json",
	};
	const counts = { inserted: 0, unchanged: 0 };
	for (const [index, record] of records.entries()) {
		const response = await fetch(`${url}/api/world/documents`, {
			method: "POST",
			headers,
			body: JSON.stringify(record),
			signal: AbortSignal.timeout(30000),
		});
		if (!response.ok)
			throw new Error(
				`document_import_failed:index=${index}:http=${response.status}`,
			);
		const result = (await response.json()) as { status: keyof typeof counts };
		if (!(result.status in counts)) throw new Error("invalid_import_response");
		counts[result.status]++;
	}
	console.log(
		JSON.stringify({ mode: "imported", count: records.length, ...counts }),
	);
}
