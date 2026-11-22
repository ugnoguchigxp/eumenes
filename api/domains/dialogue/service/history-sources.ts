import type { Database } from "bun:sqlite";
import type { Utterance } from "../../conversation";
import type { DialogueDeps } from "./context";

/** Inherited sources, or null if the utterance itself or its provenance prevents replay. */
export function inheritedHistorySources(
	deps: DialogueDeps,
	tx: Database,
	conversationId: string,
	u: Utterance,
	requireProvenance: boolean,
): readonly string[] | null {
	const id = u.messageId;
	if (
		id &&
		(deps.memory?.isSourceRevokedInTransaction(tx, id) ||
			deps.agency?.isCurrentInputInTransaction?.(
				tx,
				{ sources: [id], complete: true },
				conversationId,
			) === false)
	)
		return null;
	if (!requireProvenance || u.speaker === "user") return [];
	if (!id) return null;
	const source = deps.conversation.sourceInTransaction(tx, id);
	if (source.state !== "available") return null;
	const inherited = source.message.runId
		? deps.memory?.referenceInputs.readRunInTransaction(
				tx,
				source.message.runId,
			)
		: (deps.memory?.referenceInputs.readMessageInTransaction(tx, id) ??
			deps.agency?.inputForMessageInTransaction?.(tx, id));
	if (
		!inherited?.complete ||
		deps.memory?.referenceInputs.isCurrentInTransaction(tx, inherited) ===
			false ||
		deps.agency?.isCurrentInputInTransaction?.(
			tx,
			inherited,
			conversationId,
		) === false
	)
		return null;
	return inherited.sources;
}
