import { z } from "zod";
import { claudeCodeRequest } from "../domains/capabilities/contracts";
import type { TerminalsService } from "../domains/terminals";
import type { AdapterResult, DomainAdapter } from "../domains/tool-runtime";
import { sha256Hex } from "../infrastructure/digest";

export const TERMINALS_ADAPTER_REF = "adapter:terminals@1";
const SESSIONS = "query:terminals.sessions@1";
const REQUEST = "claude-code.request";
const RECEIPT = "domain:claude-code.receipt@1";
/** The project a conversation's direct request works in (the registry holds one for now). */
const DEFAULT_PROJECT = "eumenes";

/**
 * What was handed over, fixed when the request was saved: the receipt's digest is recorded with
 * the operation, so it carries nothing that changes while the work goes on (that is the request
 * row's state, read from the table).
 */
export const claudeCodeReceipt = z.strictObject({
	attemptId: z.string(),
	task: z.string(),
	target: z.enum(["current", "new"]),
});
type ClaudeCodeReceipt = z.infer<typeof claudeCodeReceipt>;
export const terminalsDomainSchemas = { [RECEIPT]: claudeCodeReceipt };

/**
 * Registers the session list and the conversation's Claude Code request. PTY input, output and
 * restarts from the screen use the authenticated terminal API.
 */
export const describeTerminalsAdapter = () => ({
	owner: "terminals",
	operations: new Map([
		[
			REQUEST,
			{ inputSchemaRef: "builtin:claudeCodeRequest", effect: "write" as const },
		],
	]),
	queries: new Set([SESSIONS]),
	inputAdapters: new Map(),
	projections: new Set(["projection:claude-code.result@1"]),
	availability: "availability:terminals@1",
});

/** The same operation request id always names the same terminal request. */
export function attemptIdOf(requestId: string): string {
	const hex = sha256Hex(`terminal-request:${requestId}`);
	const variant = "89ab"[Number.parseInt(hex[16]!, 16) % 4]!;
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function createTerminalsAdapter(
	terminals: Pick<
		TerminalsService,
		"available" | "list" | "enqueueInTransaction" | "requestInTransaction"
	>,
): DomainAdapter {
	function result(
		receipt: ClaudeCodeReceipt,
		requestId: string,
		replay: boolean,
	): AdapterResult {
		return {
			receipt,
			receiptRef: {
				owner: "terminals",
				operationId: requestId,
				digest: sha256Hex(JSON.stringify(receipt)),
			},
			resultRefs: [
				{
					owner: "terminals",
					kind: "claude-code-request",
					id: receipt.attemptId,
					schemaRef: RECEIPT,
					revision: 1,
				},
			],
			replay,
			// Saving is not completion: Claude Code takes the request when it is free, and the
			// conversation is told when the work is over.
			answerContext: {
				delivered: "queued",
				task: receipt.task,
				completed: false,
				reportedWhenDone: true,
			},
		};
	}
	return {
		ref: TERMINALS_ADAPTER_REF,
		describe: describeTerminalsAdapter,
		availableInTransaction: () => terminals.available(),
		snapshotInTransaction: () => {
			const list = terminals.list();
			return {
				limit: list.limit,
				sessions: list.sessions.map(({ title, status, activity, task }) => ({
					title,
					status,
					...(activity ? { activity } : {}),
					...(task ? { task } : {}),
				})),
			};
		},
		invokeInTransaction(tx, request) {
			if (request.operationName !== REQUEST)
				throw new Error("unsupported_operation");
			const attemptId = attemptIdOf(request.requestId);
			const saved = terminals.requestInTransaction(tx, attemptId);
			if (saved)
				return result(
					{
						attemptId,
						task: saved.task,
						target: saved.target === "new" ? "new" : "current",
					},
					request.requestId,
					true,
				);
			const input = claudeCodeRequest.parse(request.input);
			terminals.enqueueInTransaction(tx, {
				attemptId,
				owner: "direct",
				target: input.session === "new" ? "new" : "current",
				mode: "work",
				projectId: DEFAULT_PROJECT,
				prompt: input.prompt,
				task: input.task,
				origin:
					request.origin.kind === "conversation" ? "conversation" : "board",
				...(request.origin.kind === "conversation"
					? { conversationId: request.origin.conversationId }
					: {}),
			});
			return result(
				{
					attemptId,
					task: input.task,
					target: input.session === "new" ? "new" : "current",
				},
				request.requestId,
				false,
			);
		},
		readInTransaction(tx, operationId) {
			const saved = terminals.requestInTransaction(
				tx,
				attemptIdOf(operationId),
			);
			return saved
				? result(
						{
							attemptId: saved.id,
							task: saved.task,
							target: saved.target === "new" ? "new" : "current",
						},
						operationId,
						true,
					)
				: null;
		},
		sourceInTransaction(_tx, query, targetRef) {
			if (query !== SESSIONS || targetRef !== undefined) return null;
			const list = terminals.list();
			return { revision: list.revision, data: list };
		},
		targetInput: () => ({}),
	};
}
