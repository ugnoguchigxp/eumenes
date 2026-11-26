import { getLogger } from "../../../infrastructure/logger";
import { jstSeconds } from "../../../infrastructure/jst-time";
import type { Run } from "../contracts";
import { byId } from "../repository";
import type { DialogueDeps, GenerateInput } from "./context";
import { availableToolchainsInTransaction } from "./delegate-conversation";
import { executionSourceInTransaction } from "./execution-source";
import type { GenerationResult } from "./generation-settle";

const log = getLogger("dialogue");

/**
 * The executions a pinned submit may start: the screens' own toolchains, and a command toolchain named on
 * the command line (its sub-agent still turns the request into one typed operation).
 */
const PINNED_EXECUTIONS: ReadonlySet<string> = new Set([
	"image",
	"music-create",
	"command",
]);

/** The first decision of a run that carries its toolchain (a screen's form submit). */
export function isPinnedDecision(run: Run | null, input: GenerateInput) {
	return !!run?.pinnedToolchainId && input.final.kind === "utterances";
}

/**
 * The hand-over of a screen's form submit to the screen's own toolchain: no model call and no other candidate. The
 * request text is the submit body; the work is the agent's assignment like any delegation, told by the agent when it
 * is done, so the run's own reply is empty. A toolchain that is not available now, has no active revision or is not
 * an image / music-create / command toolchain fails the run, and so does an agenda that does not serve the
 * conversation (`agency_unavailable`).
 */
export async function pinnedGeneration(
	deps: DialogueDeps,
	input: GenerateInput,
	run: Run,
): Promise<GenerationResult> {
	const pinned = run.pinnedToolchainId!;
	const final = input.final;
	if (final.kind !== "utterances") throw new Error("run_input_missing");
	const request = input.utterances.join("\n");
	await deps.store.write((tx) => {
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
		if (!card) {
			log.warn("dialogue.pinned_toolchain_unavailable", {
				toolchainId: pinned,
			});
			throw new Error("toolchain_unavailable");
		}
		const agency = deps.agency;
		if (
			!agency?.assign ||
			!agency.servesRepliesInTransaction?.(tx, current.conversationId)
		)
			throw new Error("agency_unavailable");
		const source = executionSourceInTransaction(deps, tx, current.id);
		if (!source) throw new Error("execution_source_invalid");
		deps.continuity.events.handleInTransaction(
			tx,
			current.conversationId,
			final.seqs,
		);
		// `assign` changes the agent's memory outside this transaction: it is the last statement that can throw.
		deps.continuity.events.appendInTransaction(tx, {
			conversationId: current.conversationId,
			at: jstSeconds(Date.parse(deps.clock())),
			type: "acted",
			by: "host",
			fields: {
				action: "delegate",
				toolchain: card.id,
				request,
			},
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
		const outcome = agency.assign({
			toolchainId: card.id,
			revisionId: card.revisionId,
			title: card.title,
			request,
			references: [],
			source: {
				conversationId: source.conversationId,
				messageId: source.messageId,
				runId: source.runId,
				request: source.request,
				digest: source.digest,
			},
			userMessage: { id: source.messageId, text: source.request },
		});
		if (outcome.status === "refused") throw new Error(outcome.code);
		log.info("dialogue.pinned_operation", { toolchainId: card.id });
	});
	return { text: "" };
}
