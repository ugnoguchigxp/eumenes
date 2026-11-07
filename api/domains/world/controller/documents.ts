import { readBounded } from "../../../infrastructure/bounded-read";
import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { parseJsonBody } from "../../../infrastructure/http";
import { worldMaintenanceInput } from "../service/maintenance";
import type { WorldDocuments } from "../service/documents";
import type { WorldDocumentScope } from "../contracts/documents";

/** Authenticated owner API for importing documents; principal/Scope are bound by the host, never accepted from JSON. */
export function registerWorldDocuments(
	app: Hono,
	documents: WorldDocuments,
	scope: () => WorldDocumentScope,
) {
	app.use(
		"/api/world/maintenance/*",
		bodyLimit({
			maxSize: 1048576,
			onError: (c) => c.json({ error: "payload_too_large" }, 413),
		}),
	);
	app.get("/api/world/maintenance", (c) =>
		c.json(documents.maintenance.list(scope())),
	);
	for (const action of ["preview", "apply"] as const)
		app.post(`/api/world/maintenance/${action}`, async (c) => {
			const parsed = await parseJsonBody(c, worldMaintenanceInput, {
				code: "invalid_maintenance_input",
			});
			if (!parsed.ok) return parsed.response;
			try {
				return c.json(
					await documents.maintenance[action](scope(), parsed.data),
				);
			} catch (error) {
				if (
					error instanceof Error &&
					["maintenance_conflict", "maintenance_incomplete"].includes(
						error.message,
					)
				)
					return c.json({ error: error.message }, 409);
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
}
