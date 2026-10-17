/**
 * The shapes a case's `operation.result` must have: what the product's ports return for each operation kind
 * (`resultInTransaction` of the image, music, excalidraw and object-recognition services, and the dots delegation
 * port's result). A case author who guesses a shape would test a prompt the product never builds.
 */
import { z } from "zod";
import { imageRecord } from "../../api/domains/image/contracts";
import { musicRecord } from "../../api/domains/music/contracts";
import { recognitionRecord } from "../../api/domains/object-recognition/contracts";
import {
	taskDetailSchema,
	taskReceiptSchema,
	workTaskSchema,
} from "../../api/domains/tasks/contracts";
import type { Seed } from "../../api/domains/dialogue/eval/context/case-schema";

/** `RecordValue` of excalidraw/service/operations.ts (the drawing operation's record). */
const drawingRecord = z.strictObject({
	id: z.string(),
	runId: z.string(),
	conversationId: z.string(),
	state: z.enum(["planning", "starting", "completed", "failed", "cancelled"]),
	sessionId: z.string().nullable(),
	referenceId: z.string().nullable(),
	url: z.string().nullable(),
	action: z.string().nullable(),
	errorCode: z.string().nullable(),
	title: z.string(),
});

/** The command result the recognition port keeps for a run: `{action, ...record}`, or the bare `open` result. */
const recognitionResult = z.union([
	recognitionRecord.extend({ action: z.enum(["read", "cancel"]) }),
	z.strictObject({
		action: z.literal("open"),
		state: z.literal("ready_for_input"),
	}),
]);

/** What the dots delegation port returns: the operation, its receipt (a task receipt, or the inspection) and the verification. */
const delegationResult = z.strictObject({
	operation: z.enum(["start", "inspect", "answer", "stop"]),
	receipt: z.union([
		taskReceiptSchema,
		z.object({
			task: workTaskSchema,
			sessions: z.array(z.unknown()),
			question: taskDetailSchema.shape.question,
		}),
	]),
	verification: z.literal("registered_in_eumenes"),
});

const SHAPES: Record<NonNullable<Seed["operation"]>["kind"], z.ZodType> = {
	image: imageRecord,
	music: musicRecord,
	drawing: drawingRecord,
	recognition: recognitionResult,
	delegation: delegationResult,
};

/** Why `operation.result` is not the product's shape for its kind; empty when it is. */
export function operationShapeIssues(
	operation: NonNullable<Seed["operation"]>,
): string[] {
	const parsed = SHAPES[operation.kind].safeParse(operation.result);
	return parsed.success
		? []
		: parsed.error.issues.map(
				(issue) =>
					`${operation.kind}:${issue.path.join(".") || "(root)"}:${issue.code}`,
			);
}
