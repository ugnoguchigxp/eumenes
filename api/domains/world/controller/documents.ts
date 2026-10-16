import { readBounded } from "../../../infrastructure/bounded-read";
import type { Hono } from "hono";
import type { WorldDocuments } from "../service/documents";
import type { WorldDocumentScope } from "../contracts/documents";

/** Authenticated owner API; principal/Scope are bound by the host, never accepted from JSON. */
export function registerWorldDocuments(
	app: Hono,
	documents: WorldDocuments,
	scope: () => WorldDocumentScope,
) {
	app.get("/api/world/documents/page", (c) => {
		const { desc, ...query } = c.req.query();
		if (desc !== undefined && desc !== "true" && desc !== "false")
			return c.json({ error: "invalid_input" }, 400);
		try {
			return c.json(
				documents.page(scope(), {
					...query,
					...(desc === undefined ? {} : { desc: desc === "true" }),
				}),
			);
		} catch (error) {
			if (error instanceof Error && error.name === "ZodError")
				return c.json({ error: "invalid_input" }, 400);
			throw error;
		}
	});
	app.get("/api/world/documents", (c) => {
		try {
			const { offset, ...query } = c.req.query();
			return c.json(
				documents.lookup(scope(), {
					...query,
					...(offset === undefined ? {} : { offset: Number(offset) }),
				}),
			);
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
				tooLarge: "limit_exceeded",
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
			if (code === "limit_exceeded") return c.json({ error: code }, 413);
			if (["document_revision_conflict", "document_withdrawn"].includes(code))
				return c.json({ error: code }, 409);
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
