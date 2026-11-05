import { createHash } from "node:crypto";
import { z } from "zod";
import type { Database } from "bun:sqlite";
import type {
	BrowserInteractService,
	BrowserInteractView,
} from "../../domains/browser";
import { CONVERSATION_DEFAULT_PRINCIPAL as OWNER } from "../../domains/conversation/contracts";
import type {
	AdapterResult,
	DomainAdapter,
	InputAdapter,
	ChildExecution,
	ChildResult,
} from "../../domains/tool-runtime";
import type { BrowserRequests } from "./browser-adapter";
import { formatResourceUri } from "../../domains/resources";

export const INTERACT_ADAPTER_REF = "adapter:browser.interact@1";
export const INTERACT_QUERY = "query:browser.interact.workspace@1";
const ops = [
	["browser.interact.start", "builtin:browserInteractStart", "write"],
	["browser.interact.status", "builtin:browserInteractTarget", "read"],
	["browser.interact.answer", "builtin:browserInteractAnswer", "write"],
	["browser.interact.cancel", "builtin:browserInteractTarget", "write"],
	["browser.interact.forget", "builtin:browserInteractTarget", "write"],
] as const;
const ANSWER_INPUT = "input:browser.interact-answer@1";
const START_INPUT = "input:browser.interact-start@1";
const CONTROL_INPUT = "input:browser.interact-control@1";
const answerForm: InputAdapter = (raw) => {
	const number = (value: unknown) =>
		typeof value === "string" && /^\d{1,10}$/.test(value) ? Number(value) : NaN;
	const base = {
		runId: raw.runId,
		conversationId: raw.conversationId,
		questionId: raw.questionId,
		generation: number(raw.generation),
		expectedRevision: number(raw.expectedRevision),
	};
	if (
		!Number.isSafeInteger(base.generation) ||
		!Number.isSafeInteger(base.expectedRevision)
	)
		return {
			ok: false,
			errors: [
				{ field: "questionId", message: "最新の質問を読み直してください。" },
			],
		};
	// These are the radio control's wire values, never classification of a free-text utterance.
	if (raw.decision !== undefined) {
		if (raw.decision !== "allow" && raw.decision !== "deny")
			return {
				ok: false,
				errors: [
					{ field: "decision", message: "実行するか選択してください。" },
				],
			};
		return { ok: true, value: { ...base, approved: raw.decision === "allow" } };
	}
	return { ok: true, value: { ...base, text: raw.text } };
};
export const describeInteractAdapter = () => ({
	owner: "browser",
	operations: new Map<
		string,
		{ inputSchemaRef: string; effect: "read" | "write" }
	>(ops.map(([n, s, e]) => [n, { inputSchemaRef: s, effect: e }])),
	queries: new Set([INTERACT_QUERY]),
	inputAdapters: new Map<string, InputAdapter>([
		[
			START_INPUT,
			(raw) => ({
				ok: true,
				value: {
					request: raw.request,
					startUrl: raw.url,
					conversationId: raw.conversationId,
				},
			}),
		],
		[ANSWER_INPUT, answerForm],
		[
			CONTROL_INPUT,
			(raw) =>
				raw.intent === "cancel" || raw.confirmed === true
					? { ok: true, value: {} }
					: {
							ok: false,
							errors: [
								{
									field: "confirmed",
									message: "削除する場合は確認を選択してください。",
								},
							],
						},
		],
	]),
	projections: new Set(["projection:browser.interact-result@1"]),
	availability: "availability:browser.interact@1",
});
export const interactDomainSchemas = {
	"domain:browser.interact-receipt@1": z.strictObject({
		action: z.string(),
		runId: z.uuid(),
	}),
};
const digest = (value: unknown) =>
	createHash("sha256").update(JSON.stringify(value)).digest("hex");
const reply = (action: string, v: BrowserInteractView): AdapterResult => {
	const receipt = { action, runId: v.runId };
	const operationId = `interact.${action}:${v.runId}`;
	return {
		receipt,
		receiptRef: { owner: "browser", operationId, digest: digest(receipt) },
		resultRefs: [],
		replay: false,
		answerContext: {
			kind: "browser",
			runId: v.runId,
			state: v.state,
			captures: v.captures.length,
		},
	};
};
type Previous = {
	runId: string;
	conversationId: string;
	generation: number;
	revision: number;
	questionId: string | null;
	deadline: number;
};
function previousOf(child: ChildExecution) {
	return (
		child.resume?.previous as { result?: { domain?: Previous } } | undefined
	)?.result?.domain;
}

/** The pilot stays out of conversation discovery; explicit authenticated Artifact actions remain available. */
export function createInteractAdapter(
	service: BrowserInteractService,
	requests: BrowserRequests,
	options: { available?: () => boolean } = {},
): DomainAdapter {
	const target = (db: Database, id: string, conversationId?: string) =>
		conversationId
			? service.statusInTransaction(db, OWNER, conversationId, id)
			: service.targetInTransaction(db, OWNER, id);
	const question = (v: BrowserInteractView) =>
		v.question?.kind === "text"
			? z.strictObject({ text: z.string().trim().min(1).max(4000) })
			: z.strictObject({ approved: z.boolean() });
	return {
		ref: INTERACT_ADAPTER_REF,
		describe: describeInteractAdapter,
		availableInTransaction: () => options.available?.() ?? false,
		artifactAvailableInTransaction: () => true,
		snapshotInTransaction: (db, context) => ({
			runs: service.listInTransaction(
				db,
				OWNER,
				context?.conversationId ?? "main",
			),
		}),
		invokeInTransaction(db, r) {
			if (!describeInteractAdapter().operations.has(r.operationName))
				throw new Error("unsupported_operation");
			const input = r.input as {
				request: string;
				startUrl: string;
				maxModelCalls?: number;
				conversationId?: string;
				runId: string;
				questionId?: string;
				generation?: number;
				expectedRevision?: number;
				approved?: boolean;
				text?: string;
			};
			const originConversation =
				r.origin.kind === "conversation" || r.origin.kind === "task"
					? r.origin.conversationId
					: undefined;
			if (
				originConversation &&
				input.conversationId &&
				input.conversationId !== originConversation
			)
				throw new Error("origin_invalid");
			if (r.operationName === "browser.interact.start") {
				const child = r.origin.kind === "task" ? r.origin.execution : undefined;
				const previous = child ? previousOf(child) : undefined;
				if (previous && child?.resume) {
					const v = service.answerInTransaction(
						db,
						OWNER,
						{
							runId: previous.runId,
							conversationId: originConversation,
							questionId: previous.questionId,
							generation: previous.generation,
							expectedRevision: previous.revision,
							...question(target(db, previous.runId, originConversation)).parse(
								child.resume.input,
							),
						},
						{ kind: "execution", execution: child },
					);
					return reply("start", v);
				}
				const original =
					child?.source.request ??
					(r.origin.kind === "conversation"
						? requests.userMessageInTransaction(db, r.origin.messageId)
						: input.request);
				if (!original) throw new Error("execution_source_invalid");
				const source = child
					? { kind: "execution", execution: child }
					: r.origin.kind === "conversation"
						? {
								kind: "message",
								messageId: r.origin.messageId,
								conversationId: r.origin.conversationId,
								digest: createHash("sha256").update(original).digest("hex"),
							}
						: undefined;
				return reply(
					"start",
					service.startInTransaction(
						db,
						OWNER,
						r.requestId,
						{
							request: original,
							brief:
								child?.request ??
								(original !== input.request ? input.request : undefined),
							startUrl: input.startUrl,
							conversationId:
								originConversation ?? input.conversationId ?? "main",
							maxModelCalls: Math.min(
								10,
								input.maxModelCalls ?? 10,
								child?.modelCalls ?? 10,
							),
						},
						{
							source,
							executionId: child?.executionId,
							deadline: child?.deadline,
						},
					),
				);
			}
			const v = target(
				db,
				input.runId,
				originConversation ?? input.conversationId,
			);
			if (r.operationName === "browser.interact.status")
				return reply("status", v);
			if (r.operationName === "browser.interact.cancel")
				if (v.parentExecutionId && r.origin.kind === "ui")
					throw new Error("browser_interact_parent_control_required");
			if (r.operationName === "browser.interact.cancel")
				return reply(
					"cancel",
					service.cancelInTransaction(db, OWNER, v.conversationId, v.runId),
				);
			if (r.operationName === "browser.interact.answer")
				return reply("answer", service.answerInTransaction(db, OWNER, input));
			if (r.origin.kind !== "ui") throw new Error("origin_invalid");
			service.forgetInTransaction(db, OWNER, v.conversationId, v.runId);
			return reply("forget", v);
		},
		readInTransaction(db, id) {
			const m = /^interact\.(start|status|answer|cancel):([a-f0-9-]{36})$/.exec(
				id,
			);
			if (!m) return null;
			try {
				return reply(m[1]!, target(db, m[2]!));
			} catch {
				return null;
			}
		},
		sourceInTransaction(db, query, id, raw) {
			if (query !== INTERACT_QUERY) return null;
			// The common action host rechecks an authenticated target without query params.
			if (raw === undefined && id) {
				const selected = target(db, id);
				return {
					revision: selected.revision,
					data: { runs: [selected], selected },
				};
			}
			const params = z
				.strictObject({ conversationId: z.string().min(1).max(512) })
				.parse(raw);
			const runs = service.listInTransaction(db, OWNER, params.conversationId);
			const captured = id
				? service.captureRunInTransaction(db, OWNER, id)
				: null;
			const selected = id
				? service.statusInTransaction(
						db,
						OWNER,
						params.conversationId,
						captured?.run_id ?? id,
					)
				: (runs[0] ?? null);
			if (captured && !selected?.captures.some((c) => c.captureId === id))
				throw new Error("browser_capture_not_found");
			return {
				revision: selected?.revision ?? 0,
				data: { runs, selected, selectedCaptureId: captured ? id : null },
			};
		},
		targetInput: (_q, id) => ({ runId: id }),
		afterCommit: () => service.afterCommit(),
		execution: {
			currentInTransaction(db, id, child): ChildResult {
				const runId = /^interact\.start:([a-f0-9-]{36})$/.exec(id)?.[1];
				if (!runId) throw new Error("browser_interact_not_found");
				const v = target(db, runId, child.source.conversationId);
				if (v.parentExecutionId !== child.executionId)
					throw new Error("origin_invalid");
				const state =
					v.state === "needs_input"
						? "waiting_input"
						: v.state === "queued"
							? "running"
							: v.state;
				return {
					state,
					ref: {
						runId: v.runId,
						conversationId: v.conversationId,
						generation: v.generation,
						revision: v.revision,
						questionId: v.question?.id ?? null,
						deadline: v.deadline,
					},
					summary: v.answer ?? v.code ?? v.state,
					modelCalls: v.calls,
					references: [],
					links: v.captures.map((c) =>
						formatResourceUri("capture", c.captureId),
					),
					output: { runId: v.runId, state: v.state, captures: v.captures },
					...(v.question
						? {
								question: v.question.text,
								questionSchema: z.toJSONSchema(question(v)),
								questionDeadline: v.question.deadline!,
							}
						: {}),
				};
			},
			cancelInTransaction(db, id) {
				const runId = id.split(":")[1];
				if (runId) {
					const v = target(db, runId);
					service.cancelInTransaction(db, OWNER, v.conversationId, runId);
				}
			},
			validateAnswerInTransaction(db, id, input) {
				try {
					const v = target(db, id.split(":")[1]!);
					return (
						v.state === "needs_input" &&
						v.question!.deadline! > Date.now() &&
						question(v).safeParse(input).success
					);
				} catch {
					return false;
				}
			},
		},
	};
}
