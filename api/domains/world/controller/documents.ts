import { readBounded } from "../../../infrastructure/bounded-read";
import type { Hono } from "hono";
import { z } from "zod";
import { parseQuery, queryInt } from "../../../infrastructure/http";
import type { WorldDocuments } from "../service/documents";
import type { WorldDocumentScope } from "../contracts/documents";

// Other parameters pass through: the service validates them against its own schema.
const pageQuery = z.looseObject({
	desc: z
		.enum(["true", "false"])
		.transform((v) => v === "true")
		.optional(),
});
const lookupQuery = z.looseObject({ offset: queryInt.optional() });

/** Authenticated owner API; principal/Scope are bound by the host, never accepted from JSON. */
export function registerWorldDocuments(
	app: Hono,
	documents: WorldDocuments,
	scope: () => WorldDocumentScope,
) {
	app.get("/api/world/documents/page", (c) => {
		const query = parseQuery(c, pageQuery);
		if (!query.ok) return query.response;
		try {
			return c.json(documents.page(scope(), query.data));
		} catch (error) {
			if (error instanceof Error && error.name === "ZodError")
				return c.json({ error: "invalid_input" }, 400);
			throw error;
		}
	});
	app.get("/api/world/documents", (c) => {
		const query = parseQuery(c, lookupQuery);
		if (!query.ok) return query.response;
		try {
			return c.json(documents.lookup(scope(), query.data));
		} catch (error) {
			if (error instanceof Error && error.message === "not_found")
				return c.json({ error: "not_found" }, 404);
			if (
				error instanceof Error &&
				(error.name === "ZodError" ||
					["invalid_input", "invalid_offset"].includes(error.message))
			)
				return c.json({ error: "invalid_input" }, 400);
			throw error;
		}
	});
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
	app.delete("/api/world/documents/:id", async (c) =>
		c.json({ withdrawn: await documents.withdraw(scope(), c.req.param("id")) }),
	);
}
