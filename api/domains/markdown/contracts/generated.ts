import type { Database } from "bun:sqlite";
import { z } from "zod";
import { title } from "./index";
import { libraryPath } from "./library";

export const generatedInput = z.strictObject({
	id: z.uuid(),
	ownerRef: z.string().min(1).max(160),
	sourceRunId: z.string().min(1).max(160),
	conversationId: z.string().min(1).max(160),
	title,
	markdown: z.string().min(1).max(1_048_576),
	namespace: z.string().min(1).max(160),
	path: libraryPath.refine((v) => v.endsWith(".md")),
});
export type GeneratedInput = z.infer<typeof generatedInput>;
export type GeneratedReceipt = {
	id: string;
	title: string;
	path: string;
	state: "pending" | "settled" | "cancelled";
	local: { state: "saved" | "failed" | "expired"; uri?: string; code?: string };
	archive: {
		state: "saved" | "unsaved" | "unknown" | "conflict";
		sourceId?: string;
		code?: string;
	};
};
export type GeneratedHost = {
	validInTransaction(db: Database, id: string, ownerRef: string): boolean;
	writeLocal(input: GeneratedInput, signal: AbortSignal): Promise<string>;
	hasLocal(id: string): boolean;
	forgetLocal(id: string): void;
};
