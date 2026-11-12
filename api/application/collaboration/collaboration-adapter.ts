import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { pipelineDefinition } from "eumenes-pipeline";
import { collaborationInputs } from "../../domains/capabilities";
import type {
	CollaborationKind,
	CollaborationWorks,
	Source,
} from "../../domains/collaboration";
import type {
	AdapterOrigin,
	AdapterResult,
	DomainAdapter,
} from "../../domains/tool-runtime";

export const collaborationRef = (kind: CollaborationKind) =>
	`adapter:collaboration.${kind}@1`;
const query = "query:collaboration.current@1";
const operation = (kind: CollaborationKind, action: string) =>
	`collaboration.${kind}.${action}`;
const startInputs = {
	pipeline: "collaborationPipelineStart",
	interact: "collaborationInteractStart",
	brave: "collaborationBraveStart",
	task: "collaborationTaskStart",
} as const;
const digest = (value: unknown) =>
	createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function describeCollaborationAdapter(kind: CollaborationKind) {
	return {
		owner: "collaboration",
		operations: new Map<
			string,
			{ inputSchemaRef: string; effect: "read" | "write" }
		>([
			[
				operation(kind, "start"),
				{
					inputSchemaRef: `builtin:${startInputs[kind]}`,
					effect: "write" as const,
				},
			],
			[
				operation(kind, "answer"),
				{
					inputSchemaRef: "builtin:collaborationAnswer",
					effect: "write" as const,
				},
			],
			...(["status", "cancel"] as const).map(
				(action) =>
					[
						operation(kind, action),
						{
							inputSchemaRef: "builtin:emptyInput",
							effect:
								action === "status" ? ("read" as const) : ("write" as const),
						},
					] as const,
			),
			...(kind === "task"
				? ([
						[
							operation("brave", "start"),
							{
								inputSchemaRef: "builtin:collaborationBraveStart",
								effect: "write" as const,
							},
						],
						[
							operation(kind, "find"),
							{
								inputSchemaRef: "builtin:collaborationTaskFind",
								effect: "read",
							},
						],
						[
							operation(kind, "attach"),
							{
								inputSchemaRef: "builtin:collaborationTaskAttach",
								effect: "write",
							},
						],
						[
							operation(kind, "handoff"),
							{
								inputSchemaRef: "builtin:collaborationTaskHandoff",
								effect: "write",
							},
						],
						[
							operation(kind, "amend"),
							{
								inputSchemaRef: "builtin:collaborationTaskAmend",
								effect: "write",
							},
						],
					] as const)
				: []),
			...(kind === "pipeline"
				? ([
						[
							operation(kind, "review"),
							{
								inputSchemaRef: "builtin:collaborationReviewStart",
								effect: "write" as const,
							},
						],
						[
							operation(kind, "review.cancel"),
							{
								inputSchemaRef: "builtin:emptyInput",
								effect: "write" as const,
							},
						],
					] as const)
				: []),
		]),
		queries: new Set([query]),
		inputAdapters: new Map(),
		projections: new Set<string>(),
		availability: `availability:collaboration.${kind}@1`,
		workspaces: new Map(
			kind === "pipeline"
				? [
						[
							"workspace:collaboration.pipeline@1",
							{ path: "pipeline.json", mediaType: "application/json" },
						],
					]
				: [],
		),
	};
}

const specialist = (origin: AdapterOrigin) => {
	if (origin.kind !== "specialist")
		throw new Error("specialist_origin_required");
	return origin;
};

/** Collaboration shares the session host while each domain owns its execution. */
export function createCollaborationAdapter(
	kind: CollaborationKind,
	works: CollaborationWorks,
	watch: (db: Database, workRef: string, requestId: string) => void,
	discovery?: {
		source(origin: Extract<AdapterOrigin, { kind: "specialist" }>): Source;
		find: ReturnType<
			typeof import("./collaboration-task").collaborationTask
		>["find"];
		handoff: ReturnType<
			typeof import("./collaboration-task").collaborationTask
		>["handoff"];
	},
): DomainAdapter {
	function result(requestId: string, value: unknown): AdapterResult {
		const receipt = { requestId, kind };
		return {
			receipt,
			receiptRef: {
				owner: "collaboration",
				operationId: requestId,
				digest: digest(receipt),
			},
			resultRefs: [],
			replay: false,
			answerContext: value,
		};
	}
	return {
		async prepareSpecialistRead(request, signal) {
			if (kind !== "task" || request.operationName !== operation(kind, "find"))
				return;
			if (!discovery) throw new Error("collaboration_unavailable");
			const { query } = collaborationInputs.collaborationTaskFind.parse(
				request.input,
			);
			return discovery.find(query, discovery.source(request.origin), signal);
		},
		ref: collaborationRef(kind),
		describe: () => describeCollaborationAdapter(kind),
		availableInTransaction: (db) => works.available(db, kind),
		snapshotInTransaction: () => null,
		invokeInTransaction(db, request) {
			const origin = specialist(request.origin),
				row = works.read(db, origin.workRef);
			if (row?.kind !== kind || row.session_id !== origin.sessionId)
				throw new Error("work_not_found");
			const bound = {
				workRef: origin.workRef,
				sessionId: origin.sessionId,
				runId: origin.runId,
				requestId: request.requestId,
			};
			let value: unknown;
			if (request.operationName === operation(kind, "start")) {
				const { expectedRevision, ...input } = collaborationInputs[
					startInputs[kind]
				].parse(request.input);
				if (
					kind === "task" &&
					(!("revisionId" in input) ||
						typeof input.revisionId !== "string" ||
						!works.taskOffers(db, bound).includes(input.revisionId))
				)
					throw new Error("toolchain_not_offered");
				value = works.start(db, {
					...bound,
					expectedRevision,
					value: kind === "pipeline" ? undefined : input,
				});
				watch(db, origin.workRef, request.requestId);
			} else if (
				kind === "task" &&
				request.operationName === operation("brave", "start")
			) {
				const { expectedRevision, ...input } =
					collaborationInputs.collaborationBraveStart.parse(request.input);
				value = works.start(db, {
					...bound,
					expectedRevision,
					value: { brave: input },
				});
				watch(db, origin.workRef, request.requestId);
			} else if (
				kind === "task" &&
				request.operationName === operation(kind, "find")
			) {
				const offers = request.prepared as
					| Awaited<ReturnType<NonNullable<typeof discovery>["find"]>>
					| undefined;
				if (!offers) throw new Error("collaboration_unavailable");
				works.taskOffers(
					db,
					bound,
					offers.map((offer) => offer.revisionId),
				);
				value = { candidates: offers };
			} else if (
				kind === "task" &&
				request.operationName === operation(kind, "attach")
			) {
				const args = collaborationInputs.collaborationTaskAttach.parse(
					request.input,
				);
				value = works.attach(db, { ...bound, ...args });
				watch(db, origin.workRef, request.requestId);
			} else if (
				kind === "task" &&
				request.operationName === operation(kind, "handoff")
			) {
				const handoff = collaborationInputs.collaborationTaskHandoff.parse(
					request.input,
				);
				if (
					!works.taskOffers(db, bound).includes(handoff.revisionId) ||
					!discovery?.handoff(db, handoff.revisionId)
				)
					throw new Error("toolchain_not_offered");
				if (works.state(db, origin.workRef)?.dirty)
					throw new Error("collaboration_child_exists");
				return {
					...result(request.requestId, null),
					specialistHandoff: handoff,
				};
			} else if (
				kind === "task" &&
				request.operationName === operation(kind, "amend")
			) {
				const args = collaborationInputs.collaborationTaskAmend.parse(
					request.input,
				);
				value = works.amend(db, { ...bound, ...args });
				watch(db, origin.workRef, request.requestId);
			} else if (request.operationName === operation(kind, "answer")) {
				const args = collaborationInputs["collaborationAnswer"].parse(
					request.input,
				);
				value = works.answer(db, { ...bound, ...args, value: args.input });
				watch(db, origin.workRef, request.requestId);
			} else if (request.operationName === operation(kind, "cancel")) {
				works.cancel(db, bound);
				value = works.state(db, origin.workRef);
			} else if (
				kind === "pipeline" &&
				request.operationName === operation(kind, "review")
			) {
				const args = collaborationInputs.collaborationReviewStart.parse(
					request.input,
				);
				value = works.review(db, { ...bound, ...args });
			} else if (
				kind === "pipeline" &&
				request.operationName === operation(kind, "review.cancel")
			) {
				works.cancelReview(db, bound);
				value = works.state(db, origin.workRef);
			} else if (request.operationName === operation(kind, "status"))
				value = works.state(db, origin.workRef);
			else throw new Error("collaboration_operation_unknown");
			return result(request.requestId, value);
		},
		readInTransaction(db, id) {
			// Receipts are retained by the work domain and replayed by its operation methods.
			const accepted = works.receipt(db, id, kind);
			return accepted ? result(id, accepted) : null;
		},
		sourceInTransaction(db, ref, targetRef, params) {
			if (ref !== query) return null;
			const { conversationId } =
				collaborationInputs["collaborationCurrent"].parse(params);
			const state = works.view(db, kind, conversationId, targetRef);
			return projectWork(db, works, state);
		},
		targetInput: () => ({}),
		session: {
		agentLabel: "Collaboration",
			openInTransaction: (db, input) =>
				works.open(db, kind, input.sessionId, input.targetRef),
			stateInTransaction: works.state,
			hasTargetInTransaction: () => false,
			beginTurnInTransaction: works.begin,
			endTurnInTransaction: works.release,
			endInTransaction: works.end,
			...(kind === "pipeline"
				? {
						document: {
							readInTransaction: works.document,
							check(text: string) {
								let value: unknown;
								try {
									value = JSON.parse(text);
								} catch {
									return {
										ok: false as const,
										code: "collaboration_definition_invalid",
										issues: [{ path: "", rule: "invalid_json" }],
										fixes: [],
									};
								}
								const parsed = pipelineDefinition.safeParse(value);
								return parsed.success
									? { ok: true as const, value: parsed.data, fixes: [] }
									: {
											ok: false as const,
											code: "collaboration_definition_invalid",
											issues: parsed.error.issues.map((issue) => ({
												path: issue.path.map(String).join("."),
												rule: issue.code,
											})),
											fixes: [],
										};
							},
							commitInTransaction(
								db: Database,
								workRef: string,
								input: {
									baseRevision: number;
									title?: string;
									value: unknown;
									origin: AdapterOrigin;
								},
							) {
								const origin = specialist(input.origin);
								if (origin.workRef !== workRef)
									throw new Error("work_not_found");
								return works.commit(db, {
									workRef,
									sessionId: origin.sessionId,
									runId: origin.runId,
									baseRevision: input.baseRevision,
									title: input.title,
									value: input.value,
								});
							},
							rejectInTransaction: (
								db: Database,
								workRef: string,
								draft: Omit<
									import("../../domains/tool-runtime").RejectedDraft,
									"createdAt"
								>,
							) =>
								works.reject(db, workRef, {
									...draft,
									createdAt: new Date().toISOString(),
								}),
						},
					}
				: {}),
		},
	};
}
function projectWork(
	db: Database,
	works: CollaborationWorks,
	state: ReturnType<CollaborationWorks["view"]>,
) {
	const draft = pipelineDefinition.safeParse(state?.document);
	const steps = draft.success ? draft.data.steps : [];
	const child = state?.current.child;
	const review = state?.current.review;
	const status = child
		? {
				running: "実行中",
				waiting_user: "確認待ち",
				completed: "完了",
				partial: "一部完了",
				failed: "未完了",
				cancelled: "取消済み",
				indeterminate: "結果不明",
			}[child.status]
		: state?.busy
			? "作業中"
			: "共同作業";
	return state
		? {
				revision: state.revision,
				data: {
					kind: "work-result",
					revision: state.revision,
					targetRef: state.workRef,
					work: {
						title: state.label,
						status,
						request: state.current.request,
						summary:
							child?.question?.prompt ??
							works.report(db, state.workRef) ??
							(steps.length
								? steps
										.map((step, index) => `${index + 1}. ${step.task}`)
										.join("\n")
								: child
									? "作業の状態は上に表示しています。"
									: "会話で内容を具体化します。"),
						sections: [
							...(steps.length
								? [
										{
											title: "現在の手順",
											items: steps.map(
												(step, index) =>
													`${index + 1}. ${step.task}\n確認する結果: ${step.result}`,
											),
										},
									]
								: []),
							...(review
								? [
										{
											title: "下書きの評価",
											items: [
												review.status === "running" ? "評価中" : review.summary,
											],
										},
									]
								: []),
						],
					},
				},
			}
		: null;
}
