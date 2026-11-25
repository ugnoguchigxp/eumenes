import { latestSearch } from "../repository/search-offers";
import type { Database } from "bun:sqlite";
import type { ToolchainCard } from "../../capabilities";
import { byId, latestRunOfMessage } from "../repository";
import type { DialogueDeps } from "./context";
import { readyCatalog } from "./delegate-conversation";
import { TOOL_NAMES } from "./generation-tools";

import { lineText } from "./input-text";

/** A user message as it was when a search answered it: its id and the revision of its text. */
type Source = { id: string; revision: string };
export type ConversationOffer = {
	card: ToolchainCard;
	replyId: string;
	sources: Source[];
};

/** Snapshot the version of every user message that this search answered. */
export function offerSources(
	deps: DialogueDeps,
	db: Database,
	ids: readonly string[],
): Source[] {
	const versions = ids.flatMap((id) => {
		const source = deps.conversation.sourceInTransaction(db, id);
		return source.state === "available"
			? [{ id, revision: source.revision }]
			: [];
	});
	return versions.length === ids.length ? versions : [];
}

function currentSources(
	deps: DialogueDeps,
	db: Database,
	conversationId: string,
	sources: readonly Source[],
) {
	const ids = sources.map((s) => s.id);
	return (
		sources.length > 0 &&
		sources.every(({ id, revision }) => {
			const source = deps.conversation.sourceInTransaction(db, id);
			return (
				source.state === "available" &&
				source.message.conversationId === conversationId &&
				source.revision === revision
			);
		}) &&
		!deps.memory?.blockedMessageIdsInTransaction(db, ids).size &&
		(!deps.agency?.isCurrentInputInTransaction ||
			deps.agency.isCurrentInputInTransaction(
				db,
				deps.memory?.referenceInputs.captureInTransaction(db, {
					messageIds: ids,
				}) ?? { sources: ids, complete: true },
				conversationId,
			))
	);
}

type SavedSearch = {
	candidates?: Array<{ id: string; revisionId?: string }>;
	sources?: Source[];
};
function savedSearch(text: string): SavedSearch | null {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

/** Only databases with no adopted search slot need the old utterance and its matching selection. */
function previousSearch(
	deps: DialogueDeps,
	db: Database,
	conversationId: string,
) {
	const reply = deps.conversation.input.latestReplyWithToolInTransaction(
		db,
		conversationId,
		TOOL_NAMES.search,
	);
	if (!reply?.messageId) return null;
	for (const call of reply.toolCalls.toReversed()) {
		if (call.name !== TOOL_NAMES.search) continue;
		const search = savedSearch(call.result);
		if (Array.isArray(search?.candidates))
			return { messageId: reply.messageId, search };
	}
	return null;
}

/** Rebuild the single latest list, including its unselected candidates. An invalidated list grants nothing. */
export function conversationOffers(
	deps: DialogueDeps,
	db: Database,
	conversationId: string,
): ConversationOffer[] {
	const registry = deps.toolchains;
	if (!registry) return [];
	const slot = latestSearch(db, conversationId);
	const latest = slot
		? {
				messageId: slot.message_id,
				search: slot.search_json ? savedSearch(slot.search_json) : null,
			}
		: previousSearch(deps, db, conversationId);
	if (!latest?.search?.candidates?.length) return [];
	const { messageId, search } = latest;
	const message = deps.conversation.messageInTransaction(
		db,
		messageId,
	)?.message;
	if (
		!message ||
		message.conversationId !== conversationId ||
		!deps.conversation.originalMessageInTransaction(db, messageId)
	)
		return [];

	let sources = search.sources;
	let legacy: Map<string, string> | undefined;
	if (!slot && !sources) {
		const run = message.runId
			? byId(db, message.runId)
			: latestRunOfMessage(db, messageId);
		if (
			!run ||
			run.conversationId !== conversationId ||
			!deps.conversation.originalMessageInTransaction(db, run.inputMessageId)
		)
			return [];
		sources = offerSources(deps, db, [run.inputMessageId]);
		legacy = new Map(
			registry
				.offeredInRunInTransaction?.(db, run.id, conversationId)
				.map((c) => [c.toolchainId, c.revisionId]),
		);
	}
	if (!sources?.length) return [];
	const evidence = sources.some((source) => source.id === messageId)
		? sources
		: [...sources, ...offerSources(deps, db, [messageId])];
	if (!currentSources(deps, db, conversationId, evidence)) return [];
	const active = new Map(
		readyCatalog(deps, db)
			.filter((c) => c.selectable !== false)
			.map((c) => [c.id, c.revisionId]),
	);
	return search.candidates!.flatMap(({ id, revisionId }) => {
		const revision = revisionId ?? legacy?.get(id);
		if (!revision || active.get(id) !== revision) return [];
		const card = registry.cardInTransaction(db, revision);
		return card && !card.read && card.id === id
			? [{ card, replyId: messageId, sources: evidence }]
			: [];
	});
}

/** The callable list as `## State` shows it, and the messages it stands on; prepared from the same snapshot. */
export function offerContext(
	deps: DialogueDeps,
	tx: Database,
	conversationId: string,
	stateLines: string[],
) {
	const offers = conversationOffers(deps, tx, conversationId);
	if (offers.length) {
		stateLines.push("検索済みの担当候補:");
		const seen = new Set<string>();
		for (const offer of offers) {
			const userSources = offer.sources
				.filter((source) => !seen.has(source.id))
				.flatMap((source) => {
					seen.add(source.id);
					const m = deps.conversation.messageInTransaction(
						tx,
						source.id,
					)?.message;
					return m?.role === "user" ? [lineText(m.text).slice(0, 300)] : [];
				});
			if (userSources.length)
				stateLines.push(`検索時の利用者の発言 ${JSON.stringify(userSources)}`);
			const { id, title, summary } = offer.card;
			stateLines.push(JSON.stringify({ id, title, summary }));
		}
	}
	return {
		offers,
		sources: offers.flatMap((o) => [o.replyId, ...o.sources.map((s) => s.id)]),
	};
}
