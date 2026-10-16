import { z } from "zod";
import type { Prepared } from "../../capabilities";

export const guidedWeb = (p: Prepared | undefined) =>
	p?.package.schemaKey === "guidedResearch";
const claim = z
	.object({
		text: z.string().min(1).max(500),
		status: z.enum(["verified", "unknown", "conflicting"]),
		evidence: z.array(z.string().regex(/^e[1-9][0-9]*$/)).max(3),
	})
	.strict()
	.superRefine((value, ctx) => {
		if (value.status !== "unknown" && !value.evidence.length)
			ctx.addIssue({
				code: "custom",
				path: ["evidence"],
				message: "body evidence required",
			});
	});
const guidedReport = z
	.object({
		completion: z.enum(["complete", "incomplete"]),
		answer: z.string().trim().min(1).max(8000),
		summary: z.string().min(1).max(1200),
		claims: z.array(claim).max(8),
		limitations: z.array(z.string().max(300)).max(8),
		recipe: z
			.object({
				signature: z.string().trim().min(1).max(200),
				url: z.string().url().max(2048),
				readHint: z.string().trim().min(1).max(200),
			})
			.strict()
			.optional(),
	})
	.strict();
const invoke = z
	.object({
		action: z.literal("invoke"),
		tool: z.string().min(1).max(200),
		arguments: z.record(z.string(), z.unknown()),
		/** Each planned argument has the same canonical read input as the first call. */
		readAhead: z
			.array(z.object({ url: z.string().url().max(2048) }).strict())
			.max(5)
			.optional(),
	})
	.strict();
const wait = z.object({ action: z.literal("wait") }).strict();
const finish = z
	.object({ action: z.literal("finish"), report: guidedReport })
	.strict();
export const guidedAction = z.discriminatedUnion("action", [
	invoke,
	wait,
	finish,
]);

// Published skill v1 asks for this field. Keep its output contract readable,
// without storing or comparing a second copy of the user's request.
// Reachable condition: a task binds its package revision when it starts, and
// toolchain publication also supports rollback (capabilities `publishToolchain`),
// so rolling `web.search` back to a stored revision 2/3 (package@2/@3 with
// skill@1) starts v1 tasks again. A restart cancels every running task
// (`recover()`), so no task outlives the process that started it.
// Remove `archivedAction`/`guidedActionFor` when revisions that require
// `skill:web.guided@1` can no longer be published as active (retired from the
// catalogue), and call `guidedAction` directly.
const legacyMission = z
	.object({
		facts: z.array(z.string().min(1).max(200)).min(1).max(8),
		conditions: z.array(z.string().min(1).max(160)).max(4),
	})
	.strict();
const archivedAction = z.discriminatedUnion("action", [
	invoke.extend({ mission: legacyMission.optional() }),
	wait.extend({ mission: legacyMission.optional() }),
	finish.extend({ mission: legacyMission.optional() }),
]);
export const guidedActionFor = (p: Prepared) =>
	p.package.requiredSkillRevisionIds?.includes("skill:web.guided@1")
		? archivedAction
		: guidedAction;
export type GuidedAction = z.infer<typeof guidedAction>;
export type GuidedReport = z.infer<typeof guidedReport>;
