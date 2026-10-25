import type { Database } from "bun:sqlite";
import { packageRuntimeOf, type ToolchainCard } from "../../capabilities";
import type { ExecutionReference } from "../../tool-runtime";
import type { Run } from "../contracts";
import { extendRunDeadline, linkAnswer, transition } from "../repository";
import { COMMAND_KIND, type DialogueDeps } from "./context";
import { startSpecialistSession, type SessionStart } from "./specialist-start";
import { delegateConversation } from "./delegate-conversation";
import { executionSourceInTransaction } from "./execution-source";

/** What a dispatch did with the run. */
export type Dispatched =
	| {
			ok: true;
			/**
			 * The run waits for the work (it is queued behind the work's job): when the work reports, the run comes
			 * back as a generation triggered by the TODO's change. False for work that runs on its own (a task, a
			 * pipeline): its reports come as notices.
			 */
			handed: boolean;
			/** The owner's record (a job, an agent task, an execution), when it is known now. */
			sourceRef: string | null;
			/** A session toolchain took the conversation over: no TODO is kept for it. */
			session?: true;
	  }
	| { ok: false; code: string };

/**
 * Hands one piece of work to its toolchain, inside the writer transaction of the delegation (the ContextWindow
 * specification, sections 6.1 and 9.1). The exact revision offered must still be active. The caller has checked
 * the authority (section 6.7) and opened the TODO.
 */
export function dispatchInTransaction(
	deps: DialogueDeps,
	tx: Database,
	input: {
		/** The generation's queue job: the parent of an agent task. */
		jobId: string;
		run: Run;
		card: ToolchainCard;
		request: string;
		target?: string;
		resolveUnsaved?: "discard";
		inputs?: Record<string, unknown>;
		references: ExecutionReference[];
		/** A command toolchain's question this run answers: the interaction it resumes. */
		interactionId?: string;
	},
): Dispatched {
	const { agents, conversation, queue, clock } = deps;
	let { run } = input;
	const { card, request } = input;
	let resolved: ReturnType<
		NonNullable<DialogueDeps["toolchains"]>["resolveInTransaction"]
	>;
	try {
		if (!deps.toolchains) throw new Error("toolchain_unavailable");
		resolved = deps.toolchains.resolveInTransaction(tx, card.revisionId);
	} catch {
		return { ok: false, code: "toolchain_unavailable" };
	}
	const { runtime, packageRevisionId } = resolved;
	const original =
		conversation.messageInTransaction(tx, run.inputMessageId)?.message.text ??
		request;
	const deadline = Date.parse(run.deadlineAt!);
	const handed = (sourceRef: string | null): Dispatched => {
		transition(tx, run.id, run.revision, "queued", clock());
		return { ok: true, handed: true, sourceRef };
	};
	const media = {
		runId: run.id,
		conversationId: run.conversationId,
		question: request,
		originalRequest: original,
		deadline,
	};
	switch (runtime.execution) {
		case "excalidraw": {
			if (!deps.excalidraw)
				return { ok: false, code: "excalidraw_unavailable" };
			const saved = deps.excalidraw.startInTransaction(tx, media);
			linkAnswer(tx, run.id, saved.jobId);
			return handed(saved.jobId);
		}
		case "image": {
			if (!deps.image) return { ok: false, code: "image_unavailable" };
			const saved = deps.image.startInTransaction(tx, media);
			linkAnswer(tx, run.id, saved.jobId);
			return handed(saved.jobId);
		}
		case "music-create":
		case "music-playback": {
			if (!deps.music) return { ok: false, code: "music_unavailable" };
			const saved =
				runtime.execution === "music-create"
					? deps.music.startInTransaction(tx, media)
					: deps.music.startPlaybackInTransaction(tx, {
							...media,
							references: input.references,
						});
			linkAnswer(tx, run.id, saved.jobId);
			return handed(saved.jobId);
		}
		case "command": {
			// A command sub-agent turns the request into one typed operation of the package.
			const { job } = queue.enqueueInTransaction(tx, {
				scope: "dialogue",
				kind: COMMAND_KIND,
				dedupeKey: `toolchain-command:${run.id}`,
				payload: {
					runId: run.id,
					toolchainRevisionId: card.revisionId,
					...(input.interactionId
						? { interactionId: input.interactionId }
						: {}),
				},
				subjectRef: run.id,
				lane: "interactive",
				resourceKey: "inference.llm",
				maxAttempts: 1,
				concurrencyKey: `conversation:${run.conversationId}`,
				deadlineAtMs: deadline,
			});
			linkAnswer(tx, run.id, job.id);
			return handed(job.id);
		}
		case "session": {
			const operation: SessionStart = {
				revisionId: card.revisionId,
				request,
				...(input.target ? { target: input.target } : {}),
				...(input.resolveUnsaved
					? { resolveUnsaved: input.resolveUnsaved }
					: {}),
			};
			const started = startSpecialistSession(deps, tx, run, operation);
			if (!started.ok) return { ok: false, code: started.code };
			transition(tx, run.id, run.revision, "queued", clock());
			return { ok: true, handed: true, sourceRef: null, session: true };
		}
		case "task": {
			const source = executionSourceInTransaction(deps, tx, run.id);
			if (!agents || !source)
				return { ok: false, code: "execution_source_invalid" };
			const view = agents.executions.startInTransaction(tx, {
				source,
				request,
				references: input.references,
			});
			return { ok: true, handed: false, sourceRef: view.id };
		}
		case "pipeline": {
			const source = executionSourceInTransaction(deps, tx, run.id);
			if (!agents || !source || !card.pipeline)
				return { ok: false, code: "execution_source_invalid" };
			const view = agents.executions.startPipelineInTransaction(tx, {
				source,
				toolchainRevisionId: card.revisionId,
				inputs: input.inputs ?? {},
			});
			return { ok: true, handed: false, sourceRef: view.id };
		}
		default: {
			if (!agents || !runtime.route)
				return { ok: false, code: "invalid_conversation_operation" };
			// Only the selected package receives its declared research time; explicit outer deadlines stay fixed.
			const serviceTime =
				packageRuntimeOf(packageRevisionId.replace(/^package:|@\d+$/g, ""))
					?.budget === "service"
					? 360000
					: 0;
			if (serviceTime && run.deadlineFixed === false) {
				const until = Date.parse(run.createdAt) + serviceTime;
				if (until > deadline) {
					extendRunDeadline(tx, run.id, new Date(until).toISOString());
					deps.larm.extendDeadlineInTransaction?.(tx, run.id, until);
					run = { ...run, deadlineAt: new Date(until).toISOString() };
				}
			}
			const root = delegateConversation(
				tx,
				agents,
				conversation,
				run,
				{
					route: runtime.route,
					request,
					packageRevisionId,
				},
				{ parentJobId: input.jobId },
			);
			deps.toolchains!.linkTaskInTransaction(tx, run.id, root.taskId);
			return handed(root.taskId);
		}
	}
}
