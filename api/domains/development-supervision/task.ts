import type { Database } from "bun:sqlite";
import { z } from "zod";
import { hash, type Capabilities } from "../capabilities";
import { executionControl, type TaskLifecyclePort } from "../tool-runtime";
import { sourceCurrent } from "./authority";
import { adapterRef, type SupervisionHost } from "./contracts";
import {
	amend,
	expectedControl,
	operationReplay,
	recordOperation,
	startStop,
	stopTask,
} from "./controls";
import { answerQuestion, syncQuestions } from "./questions";
import { markNotice, type Schedule } from "./reconcile";
import { parentOf, parentOfRun, saveParent } from "./repository";
import type { Parent } from "./state";
import { executionView } from "./views";

const controlSchema = executionControl.extend({ taskRef: z.uuid().optional() });
const requiredText = z.string().trim().min(1).max(8_000);

type LifecycleDeps = {
	capabilities: Capabilities;
	getHost(): SupervisionHost | undefined;
	requiredHost(): SupervisionHost;
	now(): number;
	save(db: Database, parent: Parent, prior: Parent): void;
	cancelJob(db: Database, id: string | null): void;
	schedule: Schedule;
	changed(): void;
};

export function controlsFor({
	requiredHost,
	save,
	changed,
}: Pick<LifecycleDeps, "requiredHost" | "save" | "changed">) {
	function currentParent(db: Database, id: string, conversationId: string) {
		const currentHost = requiredHost();
		const parent = parentOf(db, id);
		if (
			!parent ||
			parent.forgotten ||
			parent.source.conversationId !== conversationId ||
			!sourceCurrent(currentHost, db, parent)
		)
			throw new Error("supervision_work_unknown");
		return parent;
	}
	function controlled(
		db: Database,
		parent: Parent,
		operationId: string,
		value: unknown,
		update: () => void,
	) {
		if (operationReplay(db, parent, { operationId }, value))
			return executionView(parent);
		const prior = structuredClone(parent);
		recordOperation(db, parent, operationId, value);
		update();
		save(db, parent, prior);
		changed();
		return executionView(parent);
	}

	return { currentParent, controlled };
}

export function createTaskPort(
	{
		getHost,
		requiredHost,
		capabilities,
		now,
		save,
		cancelJob,
		schedule,
		changed,
	}: LifecycleDeps,
	{ currentParent, controlled }: ReturnType<typeof controlsFor>,
): TaskLifecyclePort {
	return {
		startInTransaction(db, input) {
			const currentHost = requiredHost();
			const {
				source,
				references,
				toolchainRevisionId,
				bindingRevisionId,
				confirmationId,
			} = input;
			if (
				source.origin ||
				source.delegation ||
				source.specialistSessionId ||
				!source.messageId ||
				hash(source.request) !== source.digest ||
				!currentHost.validSourceInTransaction(db, source) ||
				references.some(
					(ref) => !currentHost.validReferenceInTransaction(db, source, ref),
				)
			)
				throw new Error("supervision_source_invalid");
			const set =
				toolchainRevisionId &&
				capabilities.toolchainSetInTransaction(db, toolchainRevisionId);
			const binding = set && set.binding?.document;
			if (
				!set ||
				!binding ||
				set.binding?.revisionId !== bindingRevisionId ||
				binding.execution !== "task" ||
				binding.adapterRef !== adapterRef
			)
				throw new Error("supervision_binding_invalid");
			const request = requiredText.parse(input.request);
			const proof = confirmationId
				? currentHost.confirmedRequestInTransaction?.(
						db,
						source,
						confirmationId,
						request,
					)
				: undefined;
			if (
				confirmationId &&
				(!proof || !proof.request || hash(proof.request) !== proof.digest)
			)
				throw new Error("supervision_confirmation_invalid");
			const confirmation =
				confirmationId && proof ? { id: confirmationId, ...proof } : undefined;
			const replay = parentOfRun(db, source.runId);
			if (replay) {
				if (
					replay.forgotten ||
					replay.request !== request ||
					hash(replay.source) !== hash(source) ||
					hash(replay.references) !== hash(references) ||
					hash(replay.confirmation ?? null) !== hash(confirmation ?? null)
				)
					throw new Error("operation_id_conflict");
				return executionView(replay);
			}
			const workspace = currentHost.workspace.inTransaction(db, source);
			if (!workspace) throw new Error("supervision_workspace_unavailable");
			const at = now();
			const deadline = Math.min(
				at + binding.timeLimits.runMs,
				input.deadline ?? Infinity,
			);
			if (deadline <= at) throw new Error("supervision_deadline_exceeded");
			const parent: Parent = {
				id: crypto.randomUUID(),
				generation: 0,
				revision: 0,
				source,
				...(confirmation ? { confirmation } : {}),
				request,
				workspace,
				references,
				profile: set.profile,
				skills: [...set.skills],
				deadline,
				attemptMs: binding.timeLimits.inferenceMs,
				calls: 0,
				childCalls: 0,
				ceiling: null,
				limits: {
					calls: Math.min(
						binding.limits.modelCalls,
						binding.limits.parentCalls,
					),
					children: binding.limits.childCalls,
					research: binding.limits.searches,
				},
				conversationSummary: binding.conversationSummary,
				phase: "authority",
				jobId: null,
				plan: null,
				pendingTaskId: null,
				designs: [],
				designUris: {},
				research: [],
				context: [],
				tasks: [],
				result: null,
				stop: null,
				forgotten: false,
				question: null,
				questionOp: null,
				notices: [],
				controls: [],
				observedAt: at,
				reason: "元の依頼の許可を確認中",
			};
			schedule(db, parent, "authority");
			saveParent(db, parent, true);
			changed();
			return executionView(parent);
		},
		controlInTransaction(db, conversationId, raw, messageId) {
			const input = controlSchema.parse(raw);
			const parent = currentParent(db, input.workRef, conversationId);
			if (input.action === "status") return executionView(parent);
			const currentHost = requiredHost();
			const verified = currentHost.controlSourceInTransaction(
				db,
				conversationId,
				messageId,
				parent.source,
			);
			if (!verified) throw new Error("supervision_source_invalid");
			return controlled(db, parent, messageId, input, () => {
				const cancel = (id: string | null) => cancelJob(db, id);
				const task = expectedControl(parent, {
					expectedRevision: input.expectedRevision,
					taskId: input.taskRef,
					action: input.action === "answer" ? "amend" : input.action,
				});
				if (input.action === "amend")
					amend(currentHost, db, parent, task, input.request, cancel, verified);
				else if (input.action === "cancel") {
					if (task) stopTask(currentHost, db, parent, task, cancel);
					else startStop(currentHost, db, parent, cancel, "cancelled");
				} else {
					const answer = z
						.string()
						.trim()
						.min(1)
						.max(2_000)
						.parse(verified.request);
					answerQuestion(
						currentHost,
						db,
						parent,
						{
							questionRef: input.questionRef,
							answer,
							messageId,
							operationId: messageId,
							taskId: task?.id,
						},
						now(),
					);
					syncQuestions(currentHost, db, parent, now(), markNotice);
				}
			});
		},
		viewInTransaction(db, id) {
			const parent = parentOf(db, id);
			const host = getHost();
			return host &&
				parent &&
				!parent.forgotten &&
				sourceCurrent(host, db, parent)
				? executionView(parent)
				: null;
		},
		cancelInTransaction(db, conversationId, id) {
			const parent = parentOf(db, id);
			const host = getHost();
			if (!host || !parent || parent.source.conversationId !== conversationId)
				return;
			const before = structuredClone(parent);
			startStop(host, db, parent, (jobId) => cancelJob(db, jobId), "cancelled");
			save(db, parent, before);
			changed();
		},
		forgetInTransaction(db, id) {
			const parent = parentOf(db, id);
			const host = getHost();
			if (!host || !parent || parent.forgotten) return;
			const before = structuredClone(parent);
			if (parent.stop) parent.stop = null;
			startStop(
				host,
				db,
				parent,
				(jobId) => cancelJob(db, jobId),
				"interrupted",
				true,
			);
			save(db, parent, before);
			changed();
		},
	};
}
