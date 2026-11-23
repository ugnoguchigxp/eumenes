import type { Hono } from "hono";
import type { z } from "zod";
import { bodyLimit } from "hono/body-limit";
import { parseJsonBody } from "../../../infrastructure/http";
import {
	candidatesApplyInput,
	candidatesPreviewInput,
	residueApplyInput,
	residuePreviewInput,
	type MemoryResidue,
} from "../service/residue";

/** The owner's cleanup of what an evaluation left, and the move of candidates into State (design section 6.1). */
export function registerMemoryResidue(app: Hono, residue: MemoryResidue) {
	for (const path of [
		"/api/memory/maintenance/residue/*",
		"/api/memory/maintenance/candidates/*",
	])
		app.use(
			path,
			bodyLimit({
				maxSize: 131072,
				onError: (c) => c.json({ error: "payload_too_large" }, 413),
			}),
		);
	const route = <T>(
		path: string,
		schema: z.ZodType<T>,
		run: (input: T) => unknown,
	) =>
		app.post(`/api/memory/maintenance/${path}`, async (c) => {
			const parsed = await parseJsonBody(c, schema, {
				code: "invalid_maintenance_input",
			});
			if (!parsed.ok) return parsed.response;
			try {
				return c.json(await run(parsed.data));
			} catch (error) {
				if (
					error instanceof Error &&
					["maintenance_conflict", "memory_unavailable"].includes(error.message)
				)
					return c.json({ error: error.message }, 409);
				throw error;
			}
		});
	route("residue/preview", residuePreviewInput, residue.previewResidue);
	route("residue/apply", residueApplyInput, residue.applyResidue);
	route(
		"candidates/preview",
		candidatesPreviewInput,
		residue.previewCandidates,
	);
	route("candidates/apply", candidatesApplyInput, residue.applyCandidates);
}
