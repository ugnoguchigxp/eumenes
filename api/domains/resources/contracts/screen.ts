import { z } from "zod";

/**
 * Commands to the Web screens (spec/resource-uri-implementation-plan-2026-10-25.md §8.2): open a resource's
 * screen, point at it, and play it. Every Web client of the conversation receives them; the first receipt settles.
 */
export const screenActions = ["open", "play"] as const;
export type ScreenAction = (typeof screenActions)[number];

export const screenStatuses = [
	"pending",
	"done",
	"blocked",
	"unavailable",
	"expired",
] as const;
export type ScreenStatus = (typeof screenStatuses)[number];

/** A command expires when no screen has received it within this time. */
export const SCREEN_COMMAND_TTL_MS = 30_000;

export type ScreenCommand = {
	seq: number;
	conversationId: string;
	uri: string;
	action: ScreenAction;
	adapterRef: string;
	targetRef: string;
	status: ScreenStatus;
	createdAt: string;
	settledAt: string | null;
};

/** `GET /api/screen/commands?conversationId=&after=`: pending commands after the given seq, oldest first. */
export type ScreenCommandsResponse = { commands: ScreenCommand[] };

/** `POST /api/screen/commands/:seq/receipt` */
export const screenReceiptSchema = z.strictObject({
	outcome: z.enum(["done", "blocked", "unavailable"]),
});
export type ScreenReceipt = z.infer<typeof screenReceiptSchema>;
export type ScreenReceiptResponse =
	| { ok: true; command: ScreenCommand }
	| { ok: false; code: "command_not_found" | "command_settled" };
