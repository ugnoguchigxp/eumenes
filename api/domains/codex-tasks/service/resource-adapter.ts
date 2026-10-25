import { headWithin } from "../../../infrastructure/context-budget";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import {
	formatResourceUri,
	RESOURCE_LABEL_MAX,
	type ResourceAdapter,
	type ResourceRef,
	type ResourceView,
} from "../../resources";
import type { CodexAttempt } from "../contracts";
import {
	attemptResource,
	attemptResources,
	type AttemptResource,
} from "../repository/resources";

export const CODE_TASK_RESOURCE_KIND = "code.task";
/** Ids of this owner's code tasks: `codex:<attempt id>` (kanban and shell own other prefixes). */
export const CODEX_RESOURCE_PREFIX = "codex";
/**
 * The attempt runs a card of the shared task board, and that board is the screen that shows it (this domain's own
 * screen is the settings page, which takes no target); the card id is the target.
 */
export const CODEX_BOARD_ADAPTER_REF = "adapter:kanban@2";
const READ_TOKEN_LIMIT = 600;
const PROMPT_TOKEN_LIMIT = 150;
const SUMMARY_TOKEN_LIMIT = 250;

const iso = (ms: number) => new Date(ms).toISOString();

const object = (value: unknown): Record<string, unknown> | null =>
	typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;

/** The attempt id of a `codex:<attempt id>` resource id; null for any other owner's id. */
function attemptIdOf(id: string) {
	const prefix = `${CODEX_RESOURCE_PREFIX}:`;
	return id.startsWith(prefix) && id.length > prefix.length
		? id.slice(prefix.length)
		: null;
}

const titleOf = (attempt: CodexAttempt) =>
	attempt.spec.prompt
		.split("\n")
		.map((line) => line.trim())
		.find(Boolean)
		?.slice(0, RESOURCE_LABEL_MAX)
		.trim() || "コード作業";

const refOf = ({ attempt, createdAt }: AttemptResource): ResourceRef => ({
	uri: formatResourceUri(
		CODE_TASK_RESOURCE_KIND,
		`${CODEX_RESOURCE_PREFIX}:${attempt.id}`,
	),
	kind: CODE_TASK_RESOURCE_KIND,
	label: titleOf(attempt),
	createdAt: iso(createdAt),
});

const stateLabel: Record<CodexAttempt["state"], string> = {
	accepted: "受付済み",
	starting: "開始中",
	running: "実行中",
	settling: "完了処理中",
	stopping: "停止中",
	succeeded: "完了",
	blocked: "ブロック",
	failed: "失敗",
	cancelled: "取り消し",
	unknown: "状態不明",
};

/** The attempts of the code-task worker, as `code.task` resources by `codex:<attempt id>`. */
export function createCodexTasksResourceAdapter(deps: {
	store: SqliteStore;
}): ResourceAdapter {
	return {
		kind: CODE_TASK_RESOURCE_KIND,
		fromResultInTransaction(db, result) {
			const root = object(result);
			if (!Array.isArray(root?.resultRefs)) return [];
			// Only what names one of this owner's attempts: a card receipt is the board's (kanban) to link.
			const ids = new Set<string>();
			for (const ref of root.resultRefs) {
				const item = object(ref);
				if (item?.owner === "codex-tasks" && typeof item.id === "string")
					ids.add(item.id);
			}
			const refs: ResourceRef[] = [];
			for (const id of ids) {
				const found = attemptResource(db, id);
				if (found) refs.push(refOf(found));
			}
			return refs;
		},
		getInTransaction(db, id): ResourceView | null {
			const attemptId = attemptIdOf(id);
			const found = attemptId ? attemptResource(db, attemptId) : null;
			if (!found) return null;
			return {
				...refOf(found),
				adapterRef: CODEX_BOARD_ADAPTER_REF,
				targetRef: found.attempt.cardId,
				actions: ["open", "read"],
				preview: stateLabel[found.attempt.state],
			};
		},
		async search(query) {
			const words = query.text.toLowerCase().split(/\s+/).filter(Boolean);
			const since = query.since ? Date.parse(query.since) : -Infinity;
			const until = query.until ? Date.parse(query.until) : Infinity;
			return deps.store.read((db) =>
				attemptResources(db)
					.filter(({ attempt, createdAt }) => {
						if (createdAt < since || createdAt > until) return false;
						const haystack =
							`${attempt.spec.prompt}\n${attempt.receipt?.report?.summary ?? ""}`.toLowerCase();
						return words.every((word) => haystack.includes(word));
					})
					.slice(0, query.limit)
					.map(refOf),
			);
		},
		async read(id) {
			const attemptId = attemptIdOf(id);
			const found = attemptId
				? deps.store.read((db) => attemptResource(db, attemptId))
				: null;
			if (!found) throw new Error("item_not_found");
			const { attempt } = found;
			const report = attempt.receipt?.report;
			const lines = [
				`コード作業: ${titleOf(attempt)}`,
				`状態: ${stateLabel[attempt.state]}${attempt.receipt?.reason ? `（${attempt.receipt.reason}）` : ""}`,
				`依頼: ${headWithin(attempt.spec.prompt, PROMPT_TOKEN_LIMIT).text}`,
				report?.summary &&
					`報告: ${headWithin(report.summary, SUMMARY_TOKEN_LIMIT).text}`,
				report?.blocker &&
					`ブロックの理由: ${headWithin(report.blocker, SUMMARY_TOKEN_LIMIT).text}`,
				report?.verification.length &&
					`検証: ${report.verification.slice(0, 5).join("、")}`,
				report?.unconfirmed.length &&
					`未確認: ${report.unconfirmed.slice(0, 5).join("、")}`,
				report?.files.length &&
					`変更したファイル: ${report.files.slice(0, 10).join("、")}${report.files.length > 10 ? ` ほか${report.files.length - 10}件` : ""}`,
			];
			return {
				text: headWithin(lines.filter(Boolean).join("\n"), READ_TOKEN_LIMIT)
					.text,
			};
		},
	};
}
