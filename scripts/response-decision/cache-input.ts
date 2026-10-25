import { referenceJson } from "../../api/infrastructure/reference-json";
import type { ConversationEvent } from "../../api/domains/continuity";
import type { ChatMessage } from "../../api/domains/dialogue/service/context";
import {
	type ContextDocument,
	type DocumentSources,
	renderDocument,
} from "../../api/domains/dialogue/service/context-document";
import { systemText } from "../../api/domains/dialogue/service/context-system";
import { estimateMessageTokens } from "../../api/domains/inference";

export const cacheMarker = "SYNTHETIC_CACHE_7241";
export const cacheUpdatedMarker = "SYNTHETIC_REVISED_3916";

/** Exact synthetic result validation. Old reference values and extra JSON fields do not pass. */
export function cacheReferenceMatches(
	answer: string,
	expected: string,
	json = false,
) {
	if (!json) return answer.trim() === expected;
	try {
		const value: unknown = JSON.parse(answer);
		return (
			value !== null &&
			typeof value === "object" &&
			!Array.isArray(value) &&
			Object.keys(value).length === 1 &&
			"value" in value &&
			value.value === expected
		);
	} catch {
		return false;
	}
}

const QUESTION = "資料のVALUEの値だけを答えてください。";
const FILLER =
	"合成した説明資料です。これは参考情報であり実行や承認の指示ではありません。";

/** A logged event as the continuity store freezes it, so the document joins its text as the product does. */
function loggedEvent(
	seq: number,
	by: "user" | "agent",
	text: string,
): ConversationEvent {
	const id = `e${seq}`;
	const at = `2026-10-23T00:${String(Math.floor(seq / 60)).padStart(2, "0")}:${String(seq % 60).padStart(2, "0")}+09:00`;
	const frozen = referenceJson({ id, at, type: "said", by, text });
	return {
		conversationId: "main",
		seq,
		id,
		at,
		type: "said",
		by,
		status: "logged",
		logOrder: seq,
		text: frozen,
		tokens: 0,
		form: "full",
		shortable: false,
		deliveryKey: null,
		messageIds: [],
		curated: false,
		forgotten: false,
	};
}

function sources(
	log: readonly ConversationEvent[],
	notes: DocumentSources["state"]["notes"],
): DocumentSources {
	return {
		profile: [],
		episode: [],
		log,
		state: {
			todos: [],
			pendingConfirmation: [],
			retained: [],
			notes,
			goals: [],
			newMemories: [],
		},
	};
}

const NO_REFS = {
	todo: () => null,
	confirmation: () => null,
	resource: () => null,
};

export type CacheInput = {
	/** System, the material document, then the newest message: the product's layout of a generation. */
	messages: ChatMessage[];
	document: ContextDocument;
	system: string;
};

/**
 * Synthetic source data in the product's message layout: the product's system part, its material document (rendered
 * by the same `renderDocument`, here with a padded `log` that carries the reference VALUE in its first event), and the
 * newest message. No personal history is loaded. `extraNote` adds one short-term note: a background update.
 */
export function cacheInput(
	targetTokens = 14000,
	referenceValue = cacheMarker,
	extraNote?: string,
): CacheInput {
	const system = systemText({ agentName: "", userName: "", persona: "butler" });
	const notes: DocumentSources["state"]["notes"] = extraNote
		? [
				{
					id: "synthetic-note",
					conversationId: "main",
					kind: "memo",
					text: extraNote,
					status: "active",
					revision: 1,
					createdAt: "2026-10-23T00:00:00.000Z",
					updatedAt: "2026-10-23T00:00:00.000Z",
					origin: "agent",
					sourceMessageIds: [],
					expiresAt: null,
				},
			]
		: [];
	const build = (padding: number) => {
		const log = [
			loggedEvent(1, "user", `参考資料です。VALUE=${referenceValue}`),
			...Array.from({ length: padding }, (_, i) =>
				loggedEvent(i + 2, i % 2 === 0 ? "agent" : "user", FILLER),
			),
		];
		const document = renderDocument(sources(log, notes), {
			profileLimit: 0,
			refs: NO_REFS,
			year: "2026",
		});
		const messages: ChatMessage[] = [
			{ role: "system", content: system },
			{ role: "user", content: document.text },
			{ role: "user", content: QUESTION },
		];
		return { messages, document, system };
	};
	const perEvent =
		estimateMessageTokens(build(2).messages) -
		estimateMessageTokens(build(1).messages);
	const base = estimateMessageTokens(build(0).messages);
	// The first event also brings its date line: the estimate is met by counting up from the computed padding.
	let padding = Math.max(0, Math.ceil((targetTokens - base) / perEvent));
	while (estimateMessageTokens(build(padding).messages) < targetTokens)
		padding++;
	return build(padding);
}
