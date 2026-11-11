import type { Context, Hono } from "hono";
import { SkillSmithError, type SkillDelivery } from "eumenes-skill-smith";
import { searchSchema, submissionSchema, type Knowledge } from "./service";

function deliver(c: Context, reply: SkillDelivery | null) {
	c.header("Cache-Control", "no-store");
	if (!reply) return c.json({ error: "knowledge_request_unavailable" }, 404);
	return c.json(reply, reply.kind === "pending" ? 202 : 200);
}

export function registerKnowledge(app: Hono, knowledge: Knowledge) {
	app.post("/api/knowledge/skills", async (c) => {
		const parsed = submissionSchema.safeParse(
			await c.req.json().catch(() => null),
		);
		if (!parsed.success)
			return c.json({ error: "invalid_knowledge_request" }, 400);
		try {
			return deliver(c, await knowledge.submit(parsed.data, c.req.raw.signal));
		} catch (error) {
			if (
				error instanceof Error &&
				error.message === "knowledge_request_conflict"
			)
				return c.json({ error: "knowledge_request_conflict" }, 409);
			if (
				error instanceof SkillSmithError &&
				error.code === "permission_denied"
			)
				return c.json({ error: "permission_denied" }, 403);
			return c.json({ error: "knowledge_submission_unavailable" }, 503);
		}
	});
	app.get("/api/knowledge/skills/:ref", async (c) =>
		deliver(c, await knowledge.get(c.req.param("ref"), c.req.raw.signal)),
	);
	app.post("/api/knowledge/search", async (c) => {
		const parsed = searchSchema.safeParse(await c.req.json().catch(() => null));
		if (!parsed.success)
			return c.json({ error: "invalid_knowledge_request" }, 400);
		c.header("Cache-Control", "no-store");
		try {
			const result = await knowledge.search(parsed.data, c.req.raw.signal);
			return result
				? c.json(result)
				: c.json({ error: "contextstill_unconfigured" }, 503);
		} catch {
			return c.json({ error: "contextstill_unavailable" }, 503);
		}
	});
	app.get("/api/knowledge/sources/:ref", async (c) => {
		c.header("Cache-Control", "no-store");
		try {
			const result = await knowledge.readSource(
				c.req.param("ref"),
				c.req.raw.signal,
			);
			return result
				? c.json(result)
				: c.json({ error: "knowledge_source_unavailable" }, 404);
		} catch (error) {
			if (error instanceof Error && error.message === "contextstill_not_found")
				return c.json({ error: "knowledge_source_unavailable" }, 404);
			return c.json({ error: "contextstill_unavailable" }, 503);
		}
	});
}
