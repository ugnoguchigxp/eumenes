import { z } from "zod";
import type { Database } from "bun:sqlite";
import type { Prepared } from "../../capabilities";
import type {
	ExecutionDocument,
	ExecutionReference,
	ExecutionSource,
	ExecutionView,
	ToolchainExecutionPort,
} from "../../tool-runtime";

export const researchDraft = z.strictObject({
	completion: z.enum(["complete", "incomplete"]),
	answer: z.string().min(1).max(16000),
	summary: z.string().min(1).max(2000),
	claims: z
		.array(
			z.strictObject({
				text: z.string().min(1).max(1200),
				status: z.enum(["verified", "unknown", "conflicting"]),
				evidence: z.array(z.string().regex(/^e[1-9][0-9]*$/)).max(6),
			}),
		)
		.max(24),
	limitations: z.array(z.string().min(1).max(600)).max(16),
	stopReason: z.string().min(1).max(1000),
});
export const researchDocumentDraft = researchDraft.extend({
	title: z.string().trim().min(1).max(200),
});
export type ResearchDraft = z.infer<typeof researchDraft> & { title?: string };
export interface ResearchDocumentPort {
	flush?(): void;
	startInTransaction(
		db: Database,
		input: {
			id: string;
			ownerRef: string;
			sourceRunId: string;
			conversationId: string;
			title: string;
			markdown: string;
			namespace: string;
			path: string;
		},
	): void;
	currentInTransaction(
		db: Database,
		id: string,
	):
		(ExecutionDocument & { state: "pending" | "settled" | "cancelled" }) | null;
	cancelInTransaction(db: Database, id: string, forget?: boolean): void;
}
export type ResearchLimits = {
	parentCalls: number;
	childCalls: number;
	searches: number;
	modelCalls: number;
};
export type HostState = {
	source: ExecutionSource;
	request: string;
	references: ExecutionReference[];
	prepared: Prepared;
	toolchainRevisionId: string;
	bindingRevisionId: string;
	instructions: string;
	limits: ResearchLimits;
	inferenceMs: number;
	coreIds: string[];
	modelCalls: number;
	webCalls: number;
	searches: number;
	draft: ResearchDraft | null;
	snapshots: Record<string, ResearchDraft | null>;
	command?: { kind: "answer"; consultationId: string; text: string };
	result: ExecutionView["result"];
	saveDocument?: boolean;
	documentIds?: string[];
	publication?: {
		id: string;
		outcome: "completed" | "partial";
		result: NonNullable<ExecutionView["result"]>;
	};
};
export type SourcePort = Pick<
	ToolchainExecutionPort,
	| "validSourceInTransaction"
	| "controlSourceInTransaction"
	| "validReferenceInTransaction"
	| "readReferenceInTransaction"
	| "deliverInTransaction"
	| "deliveryStateInTransaction"
	| "revokeDeliveryInTransaction"
>;
export type WebObservation = {
	state: "waiting" | "finished" | "failed";
	code?: string;
	hits: Array<{ url: string; title: string; snippet: string }>;
	documents: Array<{
		url: string;
		title: string;
		text: string;
		fetchedAt: string;
		truncated: boolean;
	}>;
	failures: Array<{ url: string; code: string }>;
};
export interface ResearchWebPort {
	startInTransaction(
		db: Database,
		input: {
			requestId: string;
			kind: "lookup" | "read";
			arguments: Record<string, unknown>;
			deadline: number;
			timeoutMs: number;
			parentJobId?: string;
		},
	): { id: string; jobId: string };
	current(id: string): WebObservation;
	cancelInTransaction(db: Database, id: string): void;
	forgetInTransaction(db: Database, id: string): void;
	flush(): void;
}
