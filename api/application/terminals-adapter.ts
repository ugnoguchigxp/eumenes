import { z } from "zod";
import { claudeCodeRequest } from "../domains/capabilities/contracts";
import type { TerminalsService } from "../domains/terminals";
import type { AdapterResult, DomainAdapter } from "../domains/tool-runtime";
import { sha256Hex } from "../infrastructure/digest";

export const TERMINALS_ADAPTER_REF = "adapter:terminals@1";
const SESSIONS = "query:terminals.sessions@1";
const REQUEST = "claude-code.request";
const RECEIPT = "domain:claude-code.receipt@1";
/** Receipts kept for replay and re-reads; sessions themselves live only in this process. */
const KEPT_RECEIPTS = 200;

export const claudeCodeReceipt = z.strictObject({
	sessionId: z.string(),
	title: z.string(),
	task: z.string(),
	run: z.number().int(),
	/** true: Claude Code was (re)started with the request; false: typed into a running session. */
	started: z.boolean(),
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

export function createTerminalsAdapter(
	terminals: Pick<TerminalsService, "available" | "list" | "request">,
): DomainAdapter {
	const receipts = new Map<string, ClaudeCodeReceipt>();
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
					kind: "claude-code-session",
					id: receipt.sessionId,
					schemaRef: RECEIPT,
					revision: receipt.run,
				},
			],
			replay,
			// Handing over is not completion: Claude Code works on it in the session.
			answerContext: {
				delivered: receipt.started ? "started" : "added_to_running_work",
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
		invokeInTransaction(_tx, request) {
			if (request.operationName !== REQUEST)
				throw new Error("unsupported_operation");
			const saved = receipts.get(request.requestId);
			if (saved) return result(saved, request.requestId, true);
			const input = claudeCodeRequest.parse(request.input);
			const handed = terminals.request({
				...input,
				...(request.origin.kind === "conversation"
					? { conversationId: request.origin.conversationId }
					: {}),
			});
			const receipt = {
				sessionId: handed.session.id,
				title: handed.session.title,
				task: input.task,
				run: handed.session.run,
				started: handed.started,
			};
			receipts.set(request.requestId, receipt);
			if (receipts.size > KEPT_RECEIPTS)
				receipts.delete(receipts.keys().next().value!);
			return result(receipt, request.requestId, false);
		},
		readInTransaction(_tx, operationId) {
			const saved = receipts.get(operationId);
			return saved ? result(saved, operationId, true) : null;
		},
		sourceInTransaction(_tx, query, targetRef) {
			if (query !== SESSIONS || targetRef !== undefined) return null;
			const list = terminals.list();
			return { revision: list.revision, data: list };
		},
		targetInput: () => ({}),
	};
}
