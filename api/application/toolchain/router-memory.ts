import type { Hono } from "hono";
import { z } from "zod";
import type { BestV2Memory } from "eumenes_router";
import { readBounded } from "../../infrastructure/bounded-read";

/** The memory file's shape (the package checks the rest: its format, labels, vectors and dimension). */
const memorySchema = z
	.object({
		format: z.string(),
		source: z.string(),
		dimension: z.number().int().positive(),
		labels: z.array(z.string()),
		vectors: z.string(),
	})
	.strict();

/**
 * Imports best-v2's memory for the router package (spec router-package-integration 2026-11-04 §1 #6). It was made from
 * utterances, so the host brings it: neither the tarball nor Git holds it. Authentication and Origin checks run in
 * the application middleware for `/api/*`.
 */
export function registerRouterMemory(
	app: Hono,
	importMemory: (
		memory: BestV2Memory,
	) => Promise<{ count: number; source: string }>,
) {
	app.post("/api/router/memory", async (c) => {
		const raw = await readBounded(c.req.raw.body, {
			limit: 8 * 1024 * 1024,
			tooLarge: "invalid_body_size",
			missing: "invalid_body",
		});
		let input: unknown;
		try {
			input = JSON.parse(new TextDecoder().decode(raw));
		} catch {
			throw new Error("invalid_router_memory");
		}
		const memory = memorySchema.safeParse(input);
		if (!memory.success) throw new Error("invalid_router_memory");
		return c.json(await importMemory(memory.data as BestV2Memory), 200, {
			"Cache-Control": "no-store",
		});
	});
}
