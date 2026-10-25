import type { Database } from "bun:sqlite";
import {
	estimateTextTokens,
	headWithin,
} from "../../../infrastructure/context-budget";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import {
	formatResourceUri,
	RESOURCE_LABEL_MAX,
	type ResourceAdapter,
	type ResourceRef,
	type ResourceSearch,
	type ResourceView,
} from "../../resources";
import type { JobState, JobView } from "../contracts";
import { list, row, view } from "../repository";

/** The compute screen; the target is the job (the screen's `focus`, plan section 9). */
const COMPUTE_RESOURCE_ADAPTER_REF = "adapter:compute@1";
const KIND = "compute.result";
/** `read` stays well inside 600 estimated tokens (the framing lines are counted too). */
const READ_BUDGET_TOKENS = 560;
const MARK = "…（以下省略）";

const isRecord = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === "object" && !Array.isArray(value);

const stateLabel: Record<JobState, string> = {
	submitting: "送信中",
	queued: "待機中",
	running: "実行中",
	collecting: "結果を回収中",
	completed: "完了",
	failed: "失敗",
	cancelled: "取消済み",
	indeterminate: "状態を確認できない",
	deleted: "削除済み",
};

/** The first line of the code that says something (a leading comment mark is dropped); the label of a job. */
function labelOf(code: string) {
	const line = code
		.split("\n")
		.map((l) => l.replace(/^\s*#+\s*/, "").trim())
		.find(Boolean);
	return [...(line ?? "計算")].slice(0, RESOURCE_LABEL_MAX).join("");
}

const stringify = (value: unknown) => {
	try {
		return JSON.stringify(value) ?? "";
	} catch {
		return "";
	}
};

/**
 * The calculation result kind (`compute.result`) over the domain's own jobs. The id is the job id. A deleted job
 * is gone; the others show what they have (a failed job reads as its error).
 */
export function createComputeResourceAdapter(deps: {
	store: SqliteStore;
	owner: string;
}): ResourceAdapter {
	const { store, owner } = deps;
	const refOf = (job: JobView): ResourceRef => ({
		uri: formatResourceUri(KIND, job.id),
		kind: KIND,
		label: labelOf(job.code),
		createdAt: new Date(job.createdAt).toISOString(),
	});
	const owned = (db: Database, id: string) => {
		const r = row(db, id);
		return r && r.owner === owner && r.state !== "deleted" ? view(db, r) : null;
	};
	return {
		kind: KIND,
		/** `result` carries the job's id (`jobId`, or `id` of the job itself); only a completed job counts. */
		fromResultInTransaction(db: Database, result: unknown) {
			if (!isRecord(result)) return [];
			const id = [result.jobId, result.id].find(
				(value): value is string => typeof value === "string" && value !== "",
			);
			const job = id ? owned(db, id) : null;
			return job?.state === "completed" ? [refOf(job)] : [];
		},
		getInTransaction(db: Database, id: string) {
			const job = owned(db, id);
			if (!job) return null;
			const value: ResourceView = {
				...refOf(job),
				adapterRef: COMPUTE_RESOURCE_ADAPTER_REF,
				targetRef: job.id,
				actions: ["open", "read"],
				preview: stateLabel[job.state],
			};
			return value;
		},
		async search(query: ResourceSearch) {
			const words = query.text.split(/\s+/).filter(Boolean);
			const since = query.since ? Date.parse(query.since) : null;
			const until = query.until ? Date.parse(query.until) : null;
			return store
				.read((db) => list(db, owner))
				.filter((job) => {
					if (job.state === "deleted") return false;
					if (since !== null && job.createdAt < since) return false;
					if (until !== null && job.createdAt > until) return false;
					const haystack = [
						job.code,
						job.result?.stdout ?? "",
						stringify(job.result?.value),
					].join("\n");
					return words.every((word) => haystack.includes(word));
				})
				.slice(0, query.limit)
				.map(refOf);
		},
		/**
		 * The state, the time, then (in this order, each cut to its share of the budget) the code, the value, the
		 * printed output, the artifact names and the error. A cut part ends with an explicit marker.
		 */
		async read(id: string) {
			const job = store.read((db) => owned(db, id));
			if (!job) throw new Error("item_not_found");
			const head = `計算結果（${stateLabel[job.state]}）\n作成: ${new Date(job.createdAt).toISOString()}`;
			const sections: Array<[string, string, number]> = [
				["コード", job.code, 200],
				["値", stringify(job.result?.value), 140],
				["出力", job.result?.stdout ?? "", 120],
				[
					"成果物",
					job.artifacts.map((artifact) => artifact.name).join("、"),
					60,
				],
				[
					"エラー",
					job.error
						? `${job.error.code} ${job.error.message ?? ""}`.trim()
						: "",
					60,
				],
			];
			const lines = [head];
			let remaining = READ_BUDGET_TOKENS - estimateTextTokens(head);
			for (const [name, body, cap] of sections) {
				if (!body) continue;
				const title = `\n${name}: `;
				const share = Math.min(cap, remaining - estimateTextTokens(title));
				if (share < 8) continue;
				const part = `${title}${headWithin(body, share, MARK).text}`;
				lines.push(part);
				remaining -= estimateTextTokens(part);
			}
			return { text: lines.join("") };
		},
	};
}
