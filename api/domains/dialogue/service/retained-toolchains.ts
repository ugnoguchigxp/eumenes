import type { Database } from "bun:sqlite";
import type { ToolchainCard } from "../../capabilities";
import { estimateJsonTokens, estimateTextTokens } from "../../inference";
import type { Run } from "../contracts";
import {
	resetRetained,
	retainedReferences,
	retainedState,
	removeRetained,
	runSequence,
	saveRetained,
	type RetainedReference,
} from "../repository/retained-toolchains";
import type { DialogueDeps, GenerateInput } from "./context";
import { analysisTools } from "./initial-decision";
import { sessionFunctionNames } from "./specialist-context";
import { omitted } from "./context-fit";

export const RETAINED_TOOLCHAIN_LIMIT = 4;
export const RETAINED_TOOLCHAIN_TOKENS = 4096;
const NOTE_CHARS = 600;
const REFERENCE_PREFIX = "toolchainUsageReference=";
export type SourcePin = { messageId: string; revision: string };
export type PreparedToolchains = {
	epoch: number;
	sequence: number;
	budget: number;
	entries: RetainedReference[];
	/** Frozen provenance, independent of later LRU changes or an explicit retention reset. */
	pins: SourcePin[];
};
function source(deps: DialogueDeps, db: Database, messageId: string) {
	if (
		deps.memory?.blockedMessageIdsInTransaction(db, [messageId]).has(messageId)
	)
		return undefined;
	const state = deps.conversation.sourceInTransaction(db, messageId);
	return state.state === "available" ? state : undefined;
}
function clip(text: string) {
	const chars = [...text];
	return chars.length <= NOTE_CHARS
		? text
		: chars.slice(0, NOTE_CHARS).join("") + omitted(chars.length - NOTE_CHARS);
}
/** The latest use, never a result, instruction, default argument or approval. */
export function usageReference(
	deps: DialogueDeps,
	db: Database,
	ref: RetainedReference,
) {
	const original = source(deps, db, ref.message_id);
	if (!original || original.revision !== ref.source_revision) return undefined;
	const usage = deps.toolchains?.usageOfRunInTransaction?.(
		db,
		ref.source_run_id,
	);
	if (usage && usage.selectionId !== ref.selection_id) return undefined;
	const request =
		usage?.request ??
		deps.toolchains?.requestOfRunInTransaction(db, ref.source_run_id);
	let forwarded: unknown = request ? clip(request) : undefined;
	// Structured instant arguments are included whole or omitted, never broken JSON.
	if (request) {
		try {
			const json: unknown = JSON.parse(request);
			forwarded = [...request].length <= NOTE_CHARS ? json : undefined;
		} catch {
			/* Ordinary forwarded requests are text. */
		}
	}
	return {
		revisionId: ref.revision_id,
		selectionId: ref.selection_id,
		runId: ref.source_run_id,
		messageId: ref.message_id,
		usedAt: original.message.createdAt,
		...(usage ? { outcome: usage.outcome, code: usage.code } : {}),
		originalRequest: clip(original.message.text),
		...(forwarded === undefined ? {} : { forwardedRequest: forwarded }),
	};
}
export type UsageReference = NonNullable<ReturnType<typeof usageReference>>;
export function usageMessage(notes: unknown[]) {
	return {
		role: "user" as const,
		content: REFERENCE_PREFIX + JSON.stringify(notes),
	};
}
function load(
	deps: DialogueDeps,
	db: Database,
	ref: RetainedReference,
	available: ReadonlySet<string>,
) {
	const card = deps.toolchains?.cardInTransaction(db, ref.revision_id);
	if (!card || !available.has(card.id)) return undefined;
	const note = usageReference(deps, db, ref);
	return note ? { ref, card, note } : undefined;
}
/** The estimate includes real native schemas and their reference framing, not copied/truncated definitions. */
function cost(
	deps: DialogueDeps,
	entries: Array<{ card: ToolchainCard; note: unknown }>,
) {
	const cards = entries
		.map((entry) => entry.card)
		.sort((a, b) => a.revisionId.localeCompare(b.revisionId));
	const tools = analysisTools(cards, sessionFunctionNames(deps, cards));
	const common = analysisTools([]);
	return (
		estimateJsonTokens(tools) -
		estimateJsonTokens(common) +
		(entries.length
			? estimateTextTokens(
					usageMessage(entries.map((entry) => entry.note)).content,
				) + 4
			: 0)
	);
}
/** Keep the newest whole functions fitting both limits. Called only from the single writer. */
function prune(
	deps: DialogueDeps,
	db: Database,
	conversationId: string,
	available: ReadonlySet<string>,
	budget: number,
) {
	const valid = retainedReferences(db, conversationId).flatMap((ref) => {
		const entry = load(deps, db, ref, available);
		if (entry && cost(deps, [entry]) <= budget) return [entry];
		removeRetained(db, conversationId, ref.revision_id);
		return [];
	});
	const kept = [...valid];
	while (kept.length > RETAINED_TOOLCHAIN_LIMIT || cost(deps, kept) > budget) {
		const oldest = kept.pop();
		if (!oldest) break;
		removeRetained(db, conversationId, oldest.ref.revision_id);
	}
	return kept;
}
export function prepareRetained(
	deps: DialogueDeps,
	db: Database,
	run: Run,
	available: ReadonlySet<string>,
	roomTokens: number,
): PreparedToolchains {
	const budget = Math.max(0, Math.min(RETAINED_TOOLCHAIN_TOKENS, roomTokens));
	const kept = prune(deps, db, run.conversationId, available, budget);
	const current = source(deps, db, run.inputMessageId);
	if (!current) throw new Error("toolchain_context_stale");
	return {
		epoch: retainedState(db, run.conversationId).epoch,
		sequence: runSequence(db, run.id),
		budget,
		entries: kept.map((entry) => entry.ref),
		pins: [
			...(current
				? [{ messageId: current.message.id, revision: current.revision }]
				: []),
			...kept.map((entry) => ({
				messageId: entry.ref.message_id,
				revision: entry.ref.source_revision,
			})),
		],
	};
}
export function retainedOffer(
	deps: DialogueDeps,
	db: Database,
	input: GenerateInput,
) {
	const retained = input.routing?.retained;
	const entries = (retained?.entries ?? [])
		.flatMap((ref) => {
			const entry = load(deps, db, ref, new Set(input.routing!.available));
			return entry ? [entry] : [];
		})
		.sort((a, b) => a.card.revisionId.localeCompare(b.card.revisionId));
	return {
		cards: entries.map((entry) => entry.card),
		notes: entries.map((entry) => entry.note),
	};
}
/** Losing source authority revokes inference. Merely evicting/resetting a workset does not cancel execution. */
export function validRetainedSources(
	deps: DialogueDeps,
	db: Database,
	input: GenerateInput,
) {
	const prepared = input.routing?.retained;
	if (!prepared) return true;
	for (const pin of prepared.pins)
		if (source(deps, db, pin.messageId)?.revision !== pin.revision)
			return false;
	const revisions = new Set([
		...prepared.entries.map((ref) => ref.revision_id),
		...(input.routing?.offeredRevisionIds ?? []),
	]);
	for (const revisionId of revisions)
		if (!deps.toolchains?.cardInTransaction(db, revisionId)) return false;
	return true;
}
/** Called only after operation/instant-result adoption; later task completions never write the workset. */
export function retainAdopted(
	deps: DialogueDeps,
	db: Database,
	run: Run,
	input: GenerateInput,
	selectionId: string | undefined,
	revisionId: string | undefined,
) {
	const prepared = input.routing?.retained;
	if (!prepared || !selectionId || !revisionId || !deps.toolchains) return;
	const state = retainedState(db, run.conversationId);
	if (state.epoch !== prepared.epoch || state.last_use_seq >= prepared.sequence)
		return;
	const original = source(deps, db, run.inputMessageId);
	const card = deps.toolchains.cardInTransaction(db, revisionId);
	if (!original || !card) return;
	const available = new Set(input.routing!.available);
	// An existing binding fallback may have been adopted without appearing in the analysis offer.
	available.add(card.id);
	saveRetained(db, run.conversationId, {
		revision_id: revisionId,
		source_run_id: run.id,
		selection_id: selectionId,
		message_id: run.inputMessageId,
		source_revision: original.revision,
		use_seq: prepared.sequence,
	});
	prune(deps, db, run.conversationId, available, prepared.budget);
}

/** Clearing future offers does not cancel in-flight operations. */
export function resetToolchainOperation(deps: Pick<DialogueDeps, "store">) {
	return (conversationId: string) =>
		deps.store.write((db) => resetRetained(db, conversationId));
}
