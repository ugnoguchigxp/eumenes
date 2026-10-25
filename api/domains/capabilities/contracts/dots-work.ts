import { z } from "zod";
const ref = z.string().regex(/^[A-Za-z0-9-]{1,64}$/);
const revision = z.number().int().positive();
export const dotsWorkStartV1 = z.strictObject({
	projectRef: ref,
	projectRevision: revision,
	connectionRevision: revision,
	title: z.string().trim().min(1).max(120),
	request: z.string().min(1).max(8000),
	completionConditions: z.array(z.string().min(1).max(1000)).min(1).max(20),
	operations: z
		.array(
			z.enum([
				"read",
				"create_session",
				"continue_session",
				"edit",
				"check",
				"commit",
				"push",
				"publish",
				"send",
			]),
		)
		.min(1)
		.max(9),
	maxSessions: z.number().int().min(1).max(20),
	/** Work time, independent of the intake model's deadline. Bounded by saved settings. */
	runtimeSeconds: z.number().int().min(60).max(7200),
	startMode: z.enum(["register_only", "start"]),
	sessionRefs: z.array(ref).max(20),
});
export const dotsWorkListV1 = z.strictObject({
	offset: z.number().int().min(0).max(100000).default(0),
});
export const dotsWorkInspectV1 = z.strictObject({ taskRef: ref });
export const dotsWorkAnswerV1 = z.strictObject({
	taskRef: ref,
	expectedRevision: revision,
	questionId: ref,
	answer: z.string().trim().min(1).max(8000),
});
export const dotsWorkStopV1 = z.strictObject({
	taskRef: ref,
	expectedRevision: revision,
	intent: z.enum(["pause", "cancel"]),
});
