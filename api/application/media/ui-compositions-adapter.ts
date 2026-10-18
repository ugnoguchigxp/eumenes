import { z } from "zod";
import { sha256Hex } from "../../infrastructure/digest";
import type {
	AdapterOrigin,
	AdapterResult,
	DomainAdapter,
} from "../../domains/tool-runtime";
import {
	uiCompositionDelete,
	uiDraftApply,
	uiResponseFields,
	uiSubmitRequest,
	uiWorkSave,
	uiWorkStep,
} from "../../domains/capabilities/contracts";
import type { Database } from "bun:sqlite";
import {
	uiCompositionLimits,
	type Caller,
	type UiCompositionsService,
} from "../../domains/ui-compositions";

export const UI_COMPOSITIONS_ADAPTER_REF = "adapter:ui-compositions@1";
const STUDIO = "query:ui-compositions.studio@1";
const FORM = "query:ui-compositions.form@1";
const INPUT = "input:ui-compositions.response@1";
const STEP = "input:ui-compositions.step@1";
const SAVE = "input:ui-compositions.save@1";
const DELETE = "input:ui-compositions.delete@1";
const TARGET_REF = "builtin:uiTargetRef";
const uiCompositionsReceipt = z.strictObject({
	projectId: z.string(),
	state: z.string(),
	responseId: z.string().optional(),
	workRef: z.string().optional(),
	revision: z.number().int().optional(),
	savedRevision: z.number().int().optional(),
	title: z.string().optional(),
});
type Receipt = z.infer<typeof uiCompositionsReceipt>;
export const uiCompositionsDomainSchemas = {
	"domain:ui-compositions.receipt@1": uiCompositionsReceipt,
};
/** The screen sends every value as a string; revisions become the operation's integers. */
function numbers(key: "workRef" | "projectId", ...names: string[]) {
	return (raw: Record<string, unknown>) => {
		const value: Record<string, unknown> = { [key]: raw[key] };
		const errors = names.flatMap((field) => {
			const text = raw[field];
			if (typeof text !== "string" || !/^[0-9]{1,9}$/.test(text))
				return [{ field, message: "版を確認してください" }];
			value[field] = Number(text);
			return [];
		});
		return errors.length
			? { ok: false as const, errors }
			: { ok: true as const, value };
	};
}
export const describeUiCompositionsAdapter = () => ({
	owner: "ui-compositions",
	operations: new Map([
		[
			"ui-compositions.draft.apply",
			{ inputSchemaRef: "builtin:uiDraftApply", effect: "write" as const },
		],
		[
			"ui-compositions.undo",
			{ inputSchemaRef: "builtin:uiWorkStep", effect: "write" as const },
		],
		[
			"ui-compositions.redo",
			{ inputSchemaRef: "builtin:uiWorkStep", effect: "write" as const },
		],
		[
			"ui-compositions.save",
			{ inputSchemaRef: "builtin:uiWorkSave", effect: "write" as const },
		],
		[
			"ui-compositions.delete",
			{
				inputSchemaRef: "builtin:uiCompositionDelete",
				effect: "write" as const,
			},
		],
		[
			"ui-compositions.submit",
			{ inputSchemaRef: "builtin:uiSubmitRequest", effect: "write" as const },
		],
	]),
	queries: new Set([STUDIO, FORM]),
	inputAdapters: new Map([
		[STEP, numbers("workRef", "expectedRevision")],
		[SAVE, numbers("workRef", "expectedRevision", "expectedSavedRevision")],
		[DELETE, numbers("projectId", "expectedSavedRevision")],
		[
			INPUT,
			(raw: Record<string, unknown>) => {
				const values = uiResponseFields.safeParse(raw);
				return values.success
					? { ok: true as const, value: { values: values.data } }
					: {
							ok: false as const,
							errors: [{ field: "values", message: "入力を確認してください" }],
						};
			},
		],
	]),
	projections: new Set(["projection:ui-compositions.result@1"]),
	availability: "availability:ui-compositions@1",
});

function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
	const parsed = schema.safeParse(input);
	if (!parsed.success) throw new Error("ui_input_invalid");
	return parsed.data;
}
/** The operations are for the screen's own actions and the session's specialist turn only. */
function callerOf(origin: AdapterOrigin): Caller {
	if (origin.kind === "ui") return { kind: "ui" };
	if (origin.kind === "specialist")
		return { kind: "specialist", runId: origin.runId, workRef: origin.workRef };
	throw new Error("origin_not_allowed");
}

export type UiCompositionsAdapterOptions = {
	/**
	 * Whether the dialogue session that owns a work is still live. A screen action on the work of
	 * a session that expired or is closing (not yet swept) is refused with `session_expired`.
	 */
	sessionLive?: (db: Database, sessionId: string) => boolean;
};
const SCREEN_WORK_OPERATIONS = new Set([
	"ui-compositions.undo",
	"ui-compositions.redo",
	"ui-compositions.save",
]);

export function createUiCompositionsAdapter(
	service: UiCompositionsService,
	options: UiCompositionsAdapterOptions = {},
): DomainAdapter {
	/** A repeated request replays its receipt; anything new needs a live session. */
	function requireLiveSession(db: Database, input: unknown, requestId: string) {
		if (!options.sessionLive || service.receiptInTransaction(db, requestId))
			return;
		const workRef = (input as { workRef?: unknown } | null)?.workRef;
		const sessionId =
			typeof workRef === "string"
				? service.sessionOfWorkInTransaction(db, workRef)
				: null;
		if (sessionId && !options.sessionLive(db, sessionId))
			throw new Error("session_expired");
	}
	function result(
		receipt: Receipt,
		requestId: string,
		replay: boolean,
	): AdapterResult {
		const draft = ["drafted", "unchanged", "undone", "redone"].includes(
			receipt.state,
		);
		return {
			receipt,
			receiptRef: {
				owner: "ui-compositions",
				operationId: requestId,
				digest: sha256Hex(JSON.stringify(receipt)),
			},
			resultRefs: [
				{
					owner: "ui-compositions",
					kind: draft ? "ui-work" : "composition",
					id: receipt.projectId,
					schemaRef: "domain:ui-compositions.receipt@1",
					...(receipt.revision !== undefined
						? { revision: receipt.revision }
						: {}),
				},
			],
			replay,
			// Never the definition itself: the specialist reads the current work as input data.
			answerContext:
				receipt.state === "drafted" || receipt.state === "unchanged"
					? {
							applied: true,
							revision: receipt.revision,
							title: receipt.title,
							...(receipt.state === "unchanged" ? { unchanged: true } : {}),
						}
					: { projectId: receipt.projectId, state: receipt.state },
		};
	}
	return {
		ref: UI_COMPOSITIONS_ADAPTER_REF,
		describe: describeUiCompositionsAdapter,
		availableInTransaction: () => true,
		snapshotInTransaction: (db) => ({
			items: service
				.listInTransaction(db, uiCompositionLimits.choices)
				.map(({ id, title, savedRevision }) => ({ id, title, savedRevision })),
		}),
		choicesInTransaction: (db, inputSchemaRef) =>
			inputSchemaRef === TARGET_REF
				? service
						.listInTransaction(db, uiCompositionLimits.choices)
						.map(({ id, title }) => ({ ref: id, label: title }))
				: [],
		invokeInTransaction(db, request) {
			const caller = callerOf(request.origin);
			const { requestId } = request;
			if (SCREEN_WORK_OPERATIONS.has(request.operationName))
				requireLiveSession(db, request.input, requestId);
			switch (request.operationName) {
				case "ui-compositions.draft.apply": {
					const outcome = service.applyDraftInTransaction(
						db,
						caller,
						parseInput(uiDraftApply, request.input),
						requestId,
					);
					return result(outcome.receipt, requestId, outcome.replay);
				}
				case "ui-compositions.undo":
				case "ui-compositions.redo": {
					const outcome = service.stepInTransaction(
						db,
						request.operationName === "ui-compositions.undo" ? "undo" : "redo",
						caller,
						parseInput(uiWorkStep, request.input),
						requestId,
					);
					return result(outcome.receipt, requestId, outcome.replay);
				}
				case "ui-compositions.save": {
					const outcome = service.saveInTransaction(
						db,
						caller,
						parseInput(uiWorkSave, request.input),
						requestId,
					);
					return result(outcome.receipt, requestId, outcome.replay);
				}
				case "ui-compositions.delete": {
					const outcome = service.deleteInTransaction(
						db,
						caller,
						parseInput(uiCompositionDelete, request.input),
						requestId,
					);
					return result(outcome.receipt, requestId, outcome.replay);
				}
				case "ui-compositions.submit": {
					const outcome = service.submitInTransaction(
						db,
						caller,
						parseInput(uiSubmitRequest, request.input),
						requestId,
					);
					return result(outcome.receipt, requestId, outcome.replay);
				}
				default:
					throw new Error("ui_operation_unknown");
			}
		},
		readInTransaction(db, operationId) {
			const saved = service.receiptInTransaction(db, operationId);
			return saved ? result(saved, operationId, true) : null;
		},
		sourceInTransaction(db, query, targetRef) {
			if (query === STUDIO)
				return {
					revision: service.revisionInTransaction(db),
					data: service.studioInTransaction(db, targetRef),
				};
			if (query === FORM && targetRef) {
				const form = service.formInTransaction(db, targetRef);
				return form
					? {
							revision: form.revision,
							data: {
								kind: "form",
								fields: form.fields,
								defaults: {},
								submitLabel: "送信",
							},
						}
					: null;
			}
			return null;
		},
		targetInput(query, targetRef, revision) {
			return query === FORM
				? { projectId: targetRef, expectedGeneration: revision }
				: {};
		},
		session: {
			hasTargetInTransaction: (db, targetRef) =>
				service.hasSavedInTransaction(db, targetRef),
			openInTransaction: (db, input) =>
				service.openWorkInTransaction(db, input),
			stateInTransaction: (db, workRef) =>
				service.workStateInTransaction(db, workRef),
			beginTurnInTransaction: (db, workRef, runId) =>
				service.beginTurnInTransaction(db, workRef, runId),
			endTurnInTransaction: (db, workRef, runId) =>
				service.endTurnInTransaction(db, workRef, runId),
			endInTransaction: (db, workRef, mode) =>
				service.endWorkInTransaction(db, workRef, mode),
		},
	};
}
