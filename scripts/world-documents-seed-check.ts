import { readFileSync } from "node:fs";
import { Hono } from "hono";
import {
	createWorldDocuments,
	registerWorldDocuments,
} from "../api/domains/world";
import { openHarness, SCOPE } from "../api/domains/world/test/fixture";
import { worldDocumentInput } from "../api/domains/world/contracts/documents";
import { sha256Hex } from "../api/infrastructure/digest";

const path = process.argv[2];
if (!path) throw new Error("seed_jsonl_required");
const records = readFileSync(path, "utf8")
	.trimEnd()
	.split("\n")
	.map((line) => worldDocumentInput.parse(JSON.parse(line)));
const h = await openHarness();
const started = performance.now();
try {
	const docs = createWorldDocuments(h.store);
	const app = new Hono();
	registerWorldDocuments(app, docs, () => SCOPE);
	let inserted = 0;
	let unchanged = 0;
	let verified = 0;
	for (const expected of ["inserted", "unchanged"]) {
		for (const doc of records) {
			const response = await app.request("/api/world/documents", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(doc),
			});
			if (
				!response.ok ||
				((await response.json()) as { status: string }).status !== expected
			)
				throw new Error("seed_import_mismatch");
			if (expected === "inserted") inserted++;
			else unchanged++;
		}
	}
	for (const doc of records) {
		let offset = 0;
		let body = "";
		for (;;) {
			const response = await app.request(
				`/api/world/documents?documentId=${encodeURIComponent(doc.id)}&offset=${offset}`,
			);
			if (!response.ok) throw new Error("seed_read_failed");
			const result = (await response.json()) as {
				text: string;
				nextOffset?: number;
				digest: string;
				manifestDigest: string;
			};
			if (
				result.digest !== doc.digest ||
				result.manifestDigest !== doc.manifestDigest
			)
				throw new Error("seed_metadata_mismatch");
			body += result.text;
			if (result.nextOffset === undefined) break;
			offset = result.nextOffset;
		}
		if (body !== doc.content || `sha256:${sha256Hex(body)}` !== doc.digest)
			throw new Error("seed_content_mismatch");
		verified++;
	}
	console.log(
		JSON.stringify({
			environment: "temporary_database",
			inserted,
			unchanged,
			verified,
			milliseconds: Math.round(performance.now() - started),
		}),
	);
} finally {
	await h.cleanup();
}
