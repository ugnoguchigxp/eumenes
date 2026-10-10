import { z } from "zod";
import type { Database } from "bun:sqlite";
import type { Run } from "./index";
const ref = z
	.string()
	.min(1)
	.max(160)
	.regex(/^[a-zA-Z0-9_.:-]+$/);
export const delegationCommand = z.discriminatedUnion("operation", [
	z.strictObject({
		operation: z.literal("start"),
		projectRef: ref,
		title: z.string().trim().min(1).max(120),
		request: z.string().trim().min(1).max(8000),
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
		maxSessions: z.number().int().min(1).max(20).default(1),
		completionConditions: z
			.array(
				z
					.string()
					.trim()
					.min(1)
					.max(1000)
					.refine((v) => new TextEncoder().encode(v).length <= 1024),
			)
			.min(1)
			.max(20),
	}),
	z.strictObject({ operation: z.literal("inspect"), taskRef: ref }),
	z.strictObject({
		operation: z.literal("answer"),
		taskRef: ref,
		questionId: ref,
		answer: z
			.string()
			.trim()
			.min(1)
			.max(8000)
			.refine((v) => new TextEncoder().encode(v).length <= 8192),
	}),
	z.strictObject({
		operation: z.literal("stop"),
		taskRef: ref,
		intent: z.enum(["pause", "cancel"]),
	}),
]);
export type DelegationCommand = z.infer<typeof delegationCommand>;
export interface DelegationPort {
	prepareInTransaction(
		db: Database,
		run: Run,
	): { catalog: unknown; receipt: unknown | null; available?: boolean };
	invokeInTransaction(
		db: Database,
		run: Run,
		command: DelegationCommand,
		snapshot: unknown,
	): unknown;
}
