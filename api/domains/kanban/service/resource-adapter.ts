import { headWithin } from "../../../infrastructure/context-budget";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import {
	formatResourceUri,
	RESOURCE_LABEL_MAX,
	type ResourceAdapter,
	type ResourceRef,
	type ResourceView,
} from "../../resources";
import type { CardRow } from "../repository";
import { allCards, getCard } from "../repository";
import { latestRunOfCard } from "../repository/resources";

export const CODE_TASK_RESOURCE_KIND = "code.task";
/** Ids of this owner's code tasks: `kanban:<card id>` (codex-tasks and shell own other prefixes). */
export const KANBAN_RESOURCE_PREFIX = "kanban";
export const KANBAN_SCREEN_ADAPTER_REF = "adapter:kanban@2";
const READ_TOKEN_LIMIT = 600;
const PROMPT_TOKEN_LIMIT = 150;
const REPORT_TOKEN_LIMIT = 350;

const iso = (ms: number) => new Date(ms).toISOString();
const labelOf = (text: string) =>
	text.trim().slice(0, RESOURCE_LABEL_MAX).trim() || "コード作業";

const object = (value: unknown): Record<string, unknown> | null =>
	typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;

/** The card id of a `kanban:<card id>` resource id; null for any other owner's id. */
function cardIdOf(id: string) {
	const prefix = `${KANBAN_RESOURCE_PREFIX}:`;
	return id.startsWith(prefix) && id.length > prefix.length
		? id.slice(prefix.length)
		: null;
}

const refOf = (card: CardRow): ResourceRef => ({
	uri: formatResourceUri(
		CODE_TASK_RESOURCE_KIND,
		`${KANBAN_RESOURCE_PREFIX}:${card.id}`,
	),
	kind: CODE_TASK_RESOURCE_KIND,
	label: labelOf(card.title),
	createdAt: iso(card.createdAt),
});

function statusOf(card: CardRow) {
	if (card.column === "todo") return "未着手";
	if (card.column === "running") return "作業中";
	return card.label === "done" ? "完了" : "ブロック中";
}

/** The kanban board's cards as `code.task` resources, for any executor, by `kanban:<card id>`. */
export function createKanbanResourceAdapter(deps: {
	store: SqliteStore;
}): ResourceAdapter {
	return {
		kind: CODE_TASK_RESOURCE_KIND,
		fromResultInTransaction(db, result) {
			const root = object(result);
			if (!root) return [];
			const ids = new Set<string>();
			if (typeof root.cardId === "string") ids.add(root.cardId);
			const receipt = object(root.receipt);
			if (typeof receipt?.cardId === "string") ids.add(receipt.cardId);
			if (Array.isArray(root.resultRefs))
				for (const ref of root.resultRefs) {
					const item = object(ref);
					if (
						item?.owner === "kanban" &&
						item.kind === "card" &&
						typeof item.id === "string"
					)
						ids.add(item.id);
				}
			const refs: ResourceRef[] = [];
			for (const id of ids) {
				const card = getCard(db, id);
				if (card) refs.push(refOf(card));
			}
			return refs;
		},
		getInTransaction(db, id): ResourceView | null {
			const cardId = cardIdOf(id);
			const card = cardId ? getCard(db, cardId) : null;
			if (!card) return null;
			return {
				...refOf(card),
				adapterRef: KANBAN_SCREEN_ADAPTER_REF,
				targetRef: card.id,
				actions: ["open", "read"],
				preview: statusOf(card),
			};
		},
		async search(query) {
			const words = query.text.toLowerCase().split(/\s+/).filter(Boolean);
			const since = query.since ? Date.parse(query.since) : -Infinity;
			const until = query.until ? Date.parse(query.until) : Infinity;
			return deps.store.read((db) =>
				allCards(db)
					.filter((card) => {
						if (card.createdAt < since || card.createdAt > until) return false;
						const haystack =
							`${card.title}\n${card.prompt}\n${card.lastReport ?? ""}`.toLowerCase();
						return words.every((word) => haystack.includes(word));
					})
					.sort((a, b) => b.createdAt - a.createdAt)
					.slice(0, query.limit)
					.map(refOf),
			);
		},
		async read(id) {
			const cardId = cardIdOf(id);
			const found = cardId
				? deps.store.read((db) => {
						const card = getCard(db, cardId);
						return card && { card, run: latestRunOfCard(db, card.id) };
					})
				: null;
			if (!found) throw new Error("item_not_found");
			const { card, run } = found;
			const lines = [
				`コード作業: ${card.title}`,
				`状態: ${statusOf(card)}${card.reason ? `（${card.reason}）` : ""}`,
				card.prompt &&
					`依頼: ${headWithin(card.prompt, PROMPT_TOKEN_LIMIT).text}`,
				run && `実行: ${run.count}回、直近は${run.kind}（${run.state}）`,
				card.lastReport &&
					`報告: ${headWithin(card.lastReport, REPORT_TOKEN_LIMIT).text}`,
				card.files.length &&
					`変更したファイル: ${card.files.slice(0, 10).join("、")}${card.files.length > 10 ? ` ほか${card.files.length - 10}件` : ""}`,
			];
			return {
				text: headWithin(lines.filter(Boolean).join("\n"), READ_TOKEN_LIMIT)
					.text,
			};
		},
	};
}
