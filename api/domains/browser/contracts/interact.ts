import type {
	CoreState,
	PartCall,
	PartResult,
	PreparedStep,
} from "eumenes-interact";
import { z } from "zod";
import type { BrowserDriver } from "./ports";

export const interactStart = z.strictObject({
	request: z.string().trim().min(1).max(4000),
	brief: z.string().trim().min(1).max(4000).optional(),
	startUrl: z.url().max(2048),
	conversationId: z.string().min(1).max(512),
	maxModelCalls: z.number().int().min(1).max(10).default(10),
});
export const interactTarget = z.strictObject({
	runId: z.uuid(),
	conversationId: z.string().min(1).max(512),
});
export const interactAnswer = interactTarget.extend({
	questionId: z.uuid(),
	generation: z.number().int().min(0),
	expectedRevision: z.number().int().min(0),
	approved: z.boolean().optional(),
	text: z.string().trim().min(1).max(4000).optional(),
});
export type InteractAnswer = z.infer<typeof interactAnswer>;
export type InteractDriver = BrowserDriver & {
	readText(
		ref: string | null,
		maxChars: number,
		signal: AbortSignal,
	): Promise<import("eumenes-interact").ExtractedContent>;
};
export type InteractInference = (
	input: {
		runId: string;
		owner: string;
		conversationId: string;
		step: number;
		deadline: number;
		purpose: "execute" | "completion_review";
		prepared: PreparedStep;
		source?: unknown;
	},
	signal: AbortSignal,
	stillCurrent: (db: import("bun:sqlite").Database) => boolean,
) => Promise<string>;

export type InteractMemory = {
	request: string;
	source?: unknown;
	core: CoreState | null;
	parts?: ReturnType<
		typeof import("eumenes-interact/parts").createPartExecutor
	>;
	results: Map<string, PartResult>;
	answer?: string;
	question?: string;
	pendingPart?: PartCall;
	controller: AbortController;
	driver?: InteractDriver;
	execution?: import("eumenes-interact/parts").PartExecutionPort;
	bridge?: ReturnType<
		typeof import("../service/interact-execution").createInteractExecution
	>;
	startUrl: string;
	brief?: string;
	pendingCaptures?: Set<string>;
	captureApproval?: {
		partDigest: string;
		snapshot: string;
		generation: number;
	};
};

export type InteractMeta = {
	run_id: string;
	owner: string;
	conversation_id: string;
	request_id: string;
	input_digest: string;
	execution_id: string | null;
	generation: number;
	revision: number;
	calls: number;
	job_id: string | null;
	question_id: string | null;
	question_kind: "approval" | "capture" | "text" | null;
	question_deadline: number | null;
	approval_id: string | null;
	approval_observation: string | null;
	created_at: number;
	expires_at: number;
};
