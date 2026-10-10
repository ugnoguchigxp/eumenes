import { z } from "zod";

export const QUEUE = "dots-script-mvp";
export const EVENT = "request.created";
export const VERSION = "2026-07-28";
export const textSchema = z
	.string()
	.min(1)
	.refine(
		(v) => v.trim().length > 0 && Buffer.byteLength(v) <= 32768,
		"Expected nonempty text <= 32 KiB",
	);
export const refSchema = z
	.object({ requestId: z.uuid(), requestVersion: z.literal(1) })
	.strict();
export const answerSchema = refSchema
	.extend({ outcome: z.enum(["answered", "failed"]), text: textSchema })
	.strict();
export const receiptSchema = z
	.object({
		outcome: z.enum(["answered", "failed"]),
		text: textSchema,
		receiptId: z.string(),
		savedAt: z.iso.datetime(),
	})
	.strict();
export const requestRecordSchema = refSchema
	.extend({
		text: textSchema,
		createdAt: z.iso.datetime(),
		deadlineAt: z.iso.datetime(),
		state: z.enum(["pending", "answered", "failed", "cancelled", "expired"]),
		answer: receiptSchema.nullable(),
		delivery: z
			.object({
				eventId: z.string(),
				state: z.string(),
				attempts: z.number().int().nonnegative(),
				status: z.number().int().nullable(),
				reason: z.string().nullable(),
			})
			.strict(),
	})
	.strict();
export const sendSchema = z
	.object({
		requestId: z.uuid(),
		text: textSchema,
		deadlineMs: z.number().int().min(1000).max(86400000).default(600000),
	})
	.strict();
export const argsSchema = z.object({ queue_id: z.literal(QUEUE) }).strict();
export const deliverySchema = z
	.object({
		mode: z.literal("webhook"),
		url: z.url(),
		secret: z.string().refine((v) => {
			if (!/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(v)) return false;
			const bytes = Buffer.from(v.slice(6), "base64");
			return (
				bytes.length >= 24 &&
				bytes.length <= 64 &&
				bytes.toString("base64").replace(/=+$/, "") ===
					v.slice(6).replace(/=+$/, "")
			);
		}, "Invalid signing secret"),
	})
	.strict();
export const subscriptionSchema = z
	.object({
		name: z.literal(EVENT),
		arguments: argsSchema,
		delivery: deliverySchema,
		cursor: z.null().optional(),
		ttlMs: z.number().int().positive().max(86400000).nullable().optional(),
	})
	.strict();
export const unsubscribeSchema = subscriptionSchema
	.omit({ ttlMs: true, cursor: true })
	.extend({ delivery: deliverySchema.omit({ secret: true }) })
	.strict();
export const eventDefinition = {
	name: EVENT,
	description: `A text request from the owner's independent script. Monitor queue_id=${QUEUE}. Fetch each request with get_request, answer the owner's request, then return the complete answer using submit_answer.`,
	delivery: ["webhook"],
	inputSchema: z.toJSONSchema(argsSchema),
	payloadSchema: z.toJSONSchema(
		z
			.object({
				request_id: z.uuid(),
				request_version: z.literal(1),
				queue_id: z.literal(QUEUE),
			})
			.strict(),
	),
};
export class ContractError extends Error {
	constructor(
		public code: string,
		public status = 409,
	) {
		super(code);
	}
}
export type RequestRecord = {
	requestId: string;
	requestVersion: 1;
	text: string;
	createdAt: string;
	deadlineAt: string;
	state: "pending" | "answered" | "failed" | "cancelled" | "expired";
	answer: {
		outcome: "answered" | "failed";
		text: string;
		receiptId: string;
		savedAt: string;
	} | null;
	delivery: {
		eventId: string;
		state: string;
		attempts: number;
		status: number | null;
		reason: string | null;
	};
};
