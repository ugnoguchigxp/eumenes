import { getLogger } from "../../../infrastructure/logger";
import type { Run } from "../contracts";
import type { DialogueDeps, GenerateInput } from "./context";
import type { ConversationOperation } from "./conversation-tools";
import type { GenerationResult } from "./generation-settle";
import { currentRequestMessage } from "./request-context";
import { decisionDraft } from "./selection-trace";

const log = getLogger("dialogue");

/** The screens' own toolchains: the only executions a pinned form submit may start. */
const PINNED_EXECUTIONS: ReadonlySet<string> = new Set([
	"image",
	"music-create",
]);

/** The first decision of a run that carries its toolchain (a screen's form submit), not a result being phrased. */
export function isPinnedDecision(run: Run | null, input: GenerateInput) {
	return (
		!!run?.pinnedToolchainId &&
		!input.agent &&
		!input.mediaResult &&
		!input.operationResult
	);
}

/**
 * The hand-over of a screen's form submit to the screen's own toolchain: no analysis, no model call and no
 * other candidate. The request text is the submit body. A toolchain that is not offered now, has no active
 * revision or is not an image / music-create toolchain fails the run; there is no other route to take.
 */
export function pinnedGeneration(
	deps: DialogueDeps,
	input: GenerateInput,
	run: Run,
): GenerationResult {
	const started = Date.now();
	const pinned = run.pinnedToolchainId!;
	const card = deps.store.read((db) => {
		const entry = deps.toolchains
			?.catalogInTransaction(db)
			.find((e) => e.id === pinned);
		return entry &&
			input.routing?.available.includes(pinned) &&
			PINNED_EXECUTIONS.has(entry.runtime.execution)
			? deps.toolchains!.cardInTransaction(db, entry.revisionId)
			: undefined;
	});
	if (!card) {
		log.warn("dialogue.pinned_toolchain_unavailable", { toolchainId: pinned });
		throw new Error("toolchain_unavailable");
	}
	const request = currentRequestMessage(input).content;
	const operation: ConversationOperation = {
		kind: "toolchain",
		toolchainId: card.id,
		revisionId: card.revisionId,
		functionName: card.functionName,
		request,
	};
	log.info("dialogue.pinned_operation", { toolchainId: card.id });
	return {
		text: "",
		operation,
		selection: decisionDraft(input, started, {
			route: { cards: [card], past: [], retrieval: "none" },
		})("toolchain", {
			toolchainId: card.id,
			toolchainRevisionId: card.revisionId,
			functionName: card.functionName,
			request,
		}),
		recallPins: [],
	};
}
