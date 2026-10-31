import { readBounded } from "../../../infrastructure/bounded-read";
import type { Hono } from "hono";
import type { WorldDocuments } from "../service/documents";
import type { WorldDocumentScope } from "../contracts/documents";

/** Authenticated owner API for importing documents; principal/Scope are bound by the host, never accepted from JSON. */
export function registerWorldDocuments(
	app: Hono,
	documents: WorldDocuments,
	scope: () => WorldDocumentScope,
) {
	app.post("/api/world/documents", async (c) => {
		try {
			const bytes = await readBounded(c.req.raw.body, {
				limit: 1572864,
				tooLarge: "payload_too_large",
				missing: "invalid_input",
			});
			return c.json(
				await documents.import(
					scope(),
					JSON.parse(new TextDecoder().decode(bytes)),
				),
			);
		} catch (error) {
			const code = error instanceof Error ? error.message : "invalid_input";
			if (
				["invalid_input", "document_digest_mismatch"].includes(code) ||
				error instanceof SyntaxError ||
				(error instanceof Error && error.name === "ZodError")
			)
				return c.json({ error: "invalid_input" }, 400);
			throw error;
		}
	});
}
