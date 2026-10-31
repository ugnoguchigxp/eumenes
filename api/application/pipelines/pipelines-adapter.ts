import type { Database } from "bun:sqlite";
import type { AgentRuntime } from "../../domains/agent-runtime";
import {
	hash,
	pipelineSourceApply,
	pipelineWorkStep,
} from "../../domains/capabilities";
import {
	applySourceInTransaction,
	beginTurnInTransaction,
	checkText,
	commitDocumentInTransaction,
	documentInTransaction,
	draftToPublishInTransaction,
	endTurnInTransaction,
	endWorkInTransaction,
	flowOf,
	latestWork,
	openWorkInTransaction,
	PipelineError,
	pointerLines,
	recordPublishedInTransaction,
	rejectDocumentInTransaction,
	sessionOfWorkInTransaction,
	studioRevision,
	workRow,
	workStateInTransaction,
	type Caller,
	type WorkReceipt,
} from "../../domains/pipelines";
import type {
	AdapterOrigin,
	AdapterResult,
	DomainAdapter,
} from "../../domains/tool-runtime";
import { z } from "zod";
import type { PipelinesService } from "./pipelines-service";

export const PIPELINES_ADAPTER_REF = "adapter:pipelines@1";
const STUDIO = "query:pipelines.studio@1";
const SOURCE = "input:pipelines.source@1";
const STEP = "input:pipelines.step@1";
const TARGET_REF = "builtin:pipelineTargetRef";
/** The work document the studio's agent edits (spec task-pipeline-design §13.6). */
export const PIPELINE_DOCUMENT = "workspace:pipelines.definition@1";

const receiptSchema = z.strictObject({
	workRef: z.string(),
	state: z.enum(["drafted", "rejected", "published"]),
	revision: z.number().int(),
	toolchainId: z.string().optional(),
});

/** The screen sends every value as a string; the revision becomes the operation's integer. */
function revisionInput(raw: Record<string, unknown>) {
	const text = raw.expectedRevision;
	if (typeof text !== "string" || !/^[0-9]{1,9}$/.test(text))
		return {
			ok: false as const,
			errors: [{ field: "expectedRevision", message: "版を確認してください" }],
		};
	return {
		ok: true as const,
		value: { workRef: raw.workRef, expectedRevision: Number(text) },
	};
}
export const describePipelinesAdapter = () => ({
	owner: "pipelines",
	operations: new Map([
		[
			"pipelines.source.apply",
			{
				inputSchemaRef: "builtin:pipelineSourceApply",
				effect: "write" as const,
			},
		],
		[
			"pipelines.publish",
			{ inputSchemaRef: "builtin:pipelineWorkStep", effect: "write" as const },
		],
	]),
	queries: new Set<string>([STUDIO]),
	inputAdapters: new Map([
		[STEP, revisionInput],
		[
			SOURCE,
			(raw: Record<string, unknown>) => {
				const base = revisionInput(raw);
				if (!base.ok) return base;
				return typeof raw.text === "string" && raw.text.trim()
					? { ok: true as const, value: { ...base.value, text: raw.text } }
					: {
							ok: false as const,
							errors: [{ field: "text", message: "定義を入力してください" }],
						};
			},
		],
	]),
	projections: new Set<string>(),
	availability: "availability:pipelines@1",
	pipeline: true,
	workspaces: new Map([
		[
			PIPELINE_DOCUMENT,
			{ path: "pipeline.json", mediaType: "application/json" },
		],
	]),
});

/** The studio's operations are the screen's and the session's specialist turn only. */
function callerOf(origin: AdapterOrigin): Caller {
	if (origin.kind === "ui") return { kind: "ui" };
	if (origin.kind === "specialist")
		return { kind: "specialist", runId: origin.runId, workRef: origin.workRef };
	throw new PipelineError("origin_not_allowed");
}

/**
 * The registry entry of task pipelines (spec task-pipeline-design 2026-10-22 §13.1, §13.6). A pipeline's run is the
 * agent-runtime's parent execution: for it, this adapter only says whether the host can run one now. For the studio
 * it is the session's work and its document, the screen's source, and the screen's apply and publish.
 */
export function createPipelinesAdapter(
	runtime: () => AgentRuntime | undefined,
	pipelines: () => PipelinesService | undefined,
	options: { sessionLive?: (db: Database, sessionId: string) => boolean } = {},
): DomainAdapter {
	const service = () => pipelines() ?? fail("pipelines_unavailable");
	const fail = (code: string): never => {
		throw new PipelineError(code);
	};
	function result(
		receipt: WorkReceipt,
		requestId: string,
		replay: boolean,
	): AdapterResult {
		return {
			receipt,
			receiptRef: {
				owner: "pipelines",
				operationId: requestId,
				digest: hash(receipt),
			},
			resultRefs: [
				{
					owner: "pipelines",
					kind: receipt.state === "published" ? "pipeline" : "pipeline-work",
					id: receipt.toolchainId ?? receipt.workRef,
					schemaRef: "domain:pipelines.receipt@1",
					revision: receipt.revision,
				},
			],
			replay,
			answerContext: { state: receipt.state, revision: receipt.revision },
		};
	}
	/** A screen action on the work of a session that expired is refused; a repeated request still replays. */
	function requireLiveSession(
		db: Database,
		workRef: unknown,
		requestId: string,
	) {
		if (db.query("SELECT 1 FROM pipeline_receipts WHERE id=?").get(requestId))
			return;
		const sessionId =
			typeof workRef === "string"
				? sessionOfWorkInTransaction(db, workRef)
				: null;
		if (sessionId && options.sessionLive && !options.sessionLive(db, sessionId))
			fail("session_expired");
	}
	/** What the studio screen shows of a work: its text, its full check by line, and its flow. */
	function studioWork(db: Database, workRef: string) {
		const row = workRow(db, workRef);
		const document = documentInTransaction(db, workRef);
		if (!row || !document) return null;
		const format = document.text ? checkText(document.text) : null;
		const definition = format?.ok ? format.value : null;
		const line = definition
			? pointerLines(JSON.parse(document.text))
			: () => null;
		const full = definition
			? service().checkInTransaction(db, definition)
			: null;
		const issues = !format
			? []
			: !format.ok
				? format.issues.map((i) => ({
						pointer: i.path,
						rule: i.rule,
						line: null,
					}))
				: full && !full.ok
					? full.issues.map((i) => ({ ...i, line: line(i.pointer) }))
					: [];
		const published = row.target_id
			? service().publishedInTransaction(db, row.target_id)
			: null;
		const state = workStateInTransaction(db, workRef)!;
		return {
			workRef: row.id,
			sessionId: row.session_id,
			title: row.title,
			revision: row.revision,
			source: document.text,
			previousSource: document.previousText,
			rejected: document.rejected,
			issues,
			flow: definition ? flowOf(definition) : null,
			tests: (definition?.tests ?? []).map((t, index) => ({
				index,
				utterance: t.utterance,
			})),
			published: published
				? {
						toolchainRevisionId: published.toolchainRevisionId,
						functionName: published.functionName,
						revision: published.revision,
					}
				: null,
			dirty: state.dirty,
			busy: state.busy,
		};
	}
	return {
		ref: PIPELINES_ADAPTER_REF,
		describe: describePipelinesAdapter,
		availableInTransaction: (db) =>
			runtime()?.executions.pipelinesAvailableInTransaction(db) ?? false,
		artifactAvailableInTransaction: () => !!pipelines(),
		snapshotInTransaction: () => null,
		choicesInTransaction: (db, inputSchemaRef) =>
			inputSchemaRef === TARGET_REF
				? (pipelines()?.historyInTransaction(db) ?? []).map((p) => ({
						ref: p.toolchainId,
						label: p.title,
					}))
				: [],
		invokeInTransaction(db, request) {
			if (callerOf(request.origin).kind !== "ui") fail("origin_not_allowed");
			const { requestId } = request;
			switch (request.operationName) {
				case "pipelines.source.apply": {
					const input = pipelineSourceApply.parse(request.input);
					requireLiveSession(db, input.workRef, requestId);
					const outcome = applySourceInTransaction(db, input, requestId);
					return result(outcome.receipt, requestId, outcome.replay);
				}
				case "pipelines.publish": {
					const input = pipelineWorkStep.parse(request.input);
					requireLiveSession(db, input.workRef, requestId);
					const draft = draftToPublishInTransaction(db, input, requestId);
					if (draft.replay)
						return result(draft.replay.receipt, requestId, true);
					const published = service().publishInTransaction(
						db,
						draft.definition!,
					);
					if (!published.ok) fail("pipeline_invalid");
					const outcome = recordPublishedInTransaction(
						db,
						{
							workRef: input.workRef,
							toolchainId: (published as { toolchainId: string }).toolchainId,
						},
						requestId,
						draft.digest,
					);
					return result(outcome.receipt, requestId, false);
				}
				default:
					return fail("pipeline_operation_unknown");
			}
		},
		readInTransaction(db, operationId) {
			const saved = db
				.query("SELECT receipt_json FROM pipeline_receipts WHERE id=?")
				.get(operationId) as { receipt_json: string } | null;
			return saved
				? result(
						receiptSchema.parse(JSON.parse(saved.receipt_json)),
						operationId,
						true,
					)
				: null;
		},
		sourceInTransaction(db, query, targetRef) {
			if (query !== STUDIO || !pipelines()) return null;
			const latest = latestWork(db);
			const current =
				latest && (!targetRef || latest.target_id === targetRef)
					? latest
					: null;
			return {
				revision: studioRevision(db),
				data: {
					kind: "pipeline-studio",
					work: current ? studioWork(db, current.id) : null,
					history: service().historyInTransaction(db),
				},
			};
		},
		targetInput: () => ({}),
		afterCommit: () => pipelines()?.afterPublish(),
		session: {
			hasTargetInTransaction: (db, targetRef) =>
				!!pipelines()?.publishedInTransaction(db, targetRef),
			openInTransaction(db, input) {
				const found = input.targetRef
					? service().publishedInTransaction(db, input.targetRef)
					: null;
				if (input.targetRef && !found) fail("target_not_found");
				return openWorkInTransaction(db, {
					sessionId: input.sessionId,
					target: found
						? { toolchainId: input.targetRef!, definition: found.definition }
						: null,
				});
			},
			// The agent's input: the draft, the toolchains a step may name, and what the full check finds now.
			stateInTransaction(db, workRef) {
				const state = workStateInTransaction(db, workRef);
				if (!state) return null;
				const format = state.current.text
					? checkText(state.current.text)
					: null;
				const full = format?.ok
					? service().checkInTransaction(db, format.value)
					: null;
				return {
					...state,
					context: {
						toolchains: service().stepToolchainsInTransaction(db),
						issues: full && !full.ok ? full.issues : [],
					},
				};
			},
			beginTurnInTransaction,
			endTurnInTransaction,
			endInTransaction: endWorkInTransaction,
			document: {
				readInTransaction(db, workRef) {
					const d = documentInTransaction(db, workRef);
					return d
						? {
								revision: d.revision,
								title: d.title,
								text: d.text,
								rejected: d.rejected,
							}
						: null;
				},
				check: checkText,
				commitInTransaction: (db, workRef, input) =>
					commitDocumentInTransaction(db, callerOf(input.origin), workRef, {
						baseRevision: input.baseRevision,
						...(input.title !== undefined ? { title: input.title } : {}),
						definition: checkText(JSON.stringify(input.value)).ok
							? (input.value as never)
							: fail("pipeline_invalid"),
					}),
				rejectInTransaction: rejectDocumentInTransaction,
			},
		},
	};
}
