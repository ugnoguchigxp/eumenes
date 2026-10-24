import { getLogger } from "../../../infrastructure/logger";
import { jstSeconds } from "../../../infrastructure/jst-time";
import type { Run } from "../contracts";
import { byId } from "../repository";
import type { DialogueDeps, GenerateInput } from "./context";
import { availableToolchainsInTransaction } from "./delegate-conversation";
import type { GenerationResult } from "./generation-settle";
import { dispatchInTransaction } from "./work-dispatch";

const log = getLogger("dialogue");

/** The screens' own toolchains: the only executions a pinned form submit may start. */
const PINNED_EXECUTIONS: ReadonlySet<string> = new Set([
	"image",
	"music-create",
]);

/** The first decision of a run that carries its toolchain (a screen's form submit), not a TODO's report. */
export function isPinnedDecision(run: Run | null, input: GenerateInput) {
	return (
		!!run?.pinnedToolchainId &&
		input.final.kind === "utterances" &&
		input.trigger.every((trigger) => trigger.kind !== "todo_changed")
	);
}

/**
 * The hand-over of a screen's form submit to the screen's own toolchain: no model call and no other candidate.
 * The request text is the submit body; the work gets its TODO like any delegation. A toolchain that is not
 * available now, has no active revision or is not an image / music-create toolchain fails the run.
 */
export async function pinnedGeneration(
	deps: DialogueDeps,
	input: GenerateInput,
	run: Run,
): Promise<GenerationResult> {
	const pinned = run.pinnedToolchainId!;
	const final = input.final;
	if (final.kind !== "utterances") throw new Error("run_input_missing");
	const request = input.messages
		.slice(2)
		.map((message) => message.content)
		.join("\n");
	const handover = await deps.store.write((tx) => {
		const current = byId(tx, run.id);
		if (
			!current ||
			current.status !== "running" ||
			current.revision !== input.revision
		)
			throw new Error("run_changed");
		const entry = deps.toolchains
			?.catalogInTransaction(tx)
			.find((e) => e.id === pinned);
		const card =
			entry &&
			availableToolchainsInTransaction(deps, tx, current).has(pinned) &&
			PINNED_EXECUTIONS.has(entry.runtime.execution)
				? deps.toolchains!.cardInTransaction(tx, entry.revisionId)
				: undefined;
		if (!card || !deps.work) {
			log.warn("dialogue.pinned_toolchain_unavailable", {
				toolchainId: pinned,
			});
			throw new Error("toolchain_unavailable");
		}
		deps.continuity.events.handleInTransaction(
			tx,
			current.conversationId,
			final.seqs,
		);
		const dispatched = dispatchInTransaction(deps, tx, {
			jobId: input.jobId,
			run: current,
			card,
			request,
			references: [],
		});
		if (!dispatched.ok) throw new Error(dispatched.code);
		const { row } = deps.work.startInTransaction(tx, {
			conversationId: current.conversationId,
			runId: current.id,
			card,
			request,
			dedupeKey: `u:${final.seqs.join(",")}:delegate:${card.id}`,
			messageIds: [...new Set([...final.messageIds, current.inputMessageId])],
			...(dispatched.sourceRef ? { sourceRef: dispatched.sourceRef } : {}),
		});
		deps.continuity.events.appendInTransaction(tx, {
			conversationId: current.conversationId,
			at: jstSeconds(Date.parse(deps.clock())),
			type: "acted",
			by: "host",
			fields: { action: "delegate", toolchain: card.id, request, todo: row.id },
			dedupeKey: `${current.id}:pinned`,
		});
		deps.toolchains!.recordSelectionInTransaction(tx, {
			runId: current.id,
			conversationId: current.conversationId,
			utteranceId: current.utteranceId ?? null,
			requestId: current.requestId ?? null,
			retrieval: "none",
			candidates: [],
			historyRefs: [],
			decision: "toolchain",
			toolchainId: card.id,
			toolchainRevisionId: card.revisionId,
			functionName: card.functionName,
			request,
		});
		log.info("dialogue.pinned_operation", { toolchainId: card.id });
		return { announcement: "", handed: dispatched.handed, workId: row.id };
	});
	return { text: "", handover };
}
