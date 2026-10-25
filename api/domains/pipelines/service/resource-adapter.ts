import type { Database } from "bun:sqlite";
import { headWithin } from "../../../infrastructure/context-budget";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import { hash } from "../../capabilities";
import {
	formatResourceUri,
	RESOURCE_LABEL_MAX,
	type ResourceAdapter,
	type ResourceRef,
	type ResourceView,
} from "../../resources";
import {
	resourceWork,
	resourceWorkOfTarget,
	resourceWorks,
	type ResourceWork,
} from "../repository/resources";
import { checkText } from "./document";

export const PIPELINE_RESOURCE_KIND = "pipeline";
export const PIPELINES_SCREEN_ADAPTER_REF = "adapter:pipelines@1";
const READ_TOKEN_LIMIT = 600;
const UNTITLED = "新しいパイプライン";

const iso = (ms: number) => new Date(ms).toISOString();
const labelOf = (text: string) =>
	text.trim().slice(0, RESOURCE_LABEL_MAX).trim() || UNTITLED;

const object = (value: unknown): Record<string, unknown> | null =>
	typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;

const refOf = ({ row, createdAt }: ResourceWork): ResourceRef => ({
	uri: formatResourceUri(PIPELINE_RESOURCE_KIND, row.id),
	kind: PIPELINE_RESOURCE_KIND,
	label: labelOf(row.title),
	createdAt: iso(createdAt),
});

/** The pipeline studio's drafts: one work per specialist session, by the work's id. */
export function createPipelinesResourceAdapter(deps: {
	store: SqliteStore;
}): ResourceAdapter {
	return {
		kind: PIPELINE_RESOURCE_KIND,
		fromResultInTransaction(db: Database, result) {
			const root = object(result);
			if (!root) return [];
			const receipt = object(root.receipt) ?? root;
			// A refused draft is not what the studio's turn made.
			if (receipt.state === "rejected") return [];
			const works = new Map<string, ResourceWork>();
			const add = (found: ResourceWork | null) => {
				if (found) works.set(found.row.id, found);
			};
			if (typeof receipt.workRef === "string")
				add(resourceWork(db, receipt.workRef));
			if (Array.isArray(root.resultRefs))
				for (const ref of root.resultRefs) {
					const item = object(ref);
					if (item?.owner !== "pipelines" || typeof item.id !== "string")
						continue;
					// `pipeline-work`: a draft's work ref; `pipeline`: the published toolchain's id.
					add(
						item.kind === "pipeline"
							? resourceWorkOfTarget(db, item.id)
							: resourceWork(db, item.id),
					);
				}
			return [...works.values()].map(refOf);
		},
		getInTransaction(db, id): ResourceView | null {
			const found = resourceWork(db, id);
			if (!found) return null;
			const { row } = found;
			const summary = row.text ? checkText(row.text) : null;
			return {
				...refOf(found),
				adapterRef: PIPELINES_SCREEN_ADAPTER_REF,
				// The studio shows its latest work for the published toolchain it started from; a draft never
				// published has no toolchain id, which the studio reads as "the current draft".
				targetRef: row.target_id ?? "",
				actions: ["open", "read"],
				...(summary?.ok && summary.value.summary
					? { preview: summary.value.summary.slice(0, 80) }
					: {}),
			};
		},
		async search(query) {
			const words = query.text.toLowerCase().split(/\s+/).filter(Boolean);
			const since = query.since ? Date.parse(query.since) : -Infinity;
			const until = query.until ? Date.parse(query.until) : Infinity;
			return deps.store.read((db) =>
				resourceWorks(db)
					.filter(({ row, createdAt }) => {
						if (createdAt < since || createdAt > until) return false;
						const haystack = `${row.title}\n${row.text}`.toLowerCase();
						return words.every((word) => haystack.includes(word));
					})
					.slice(0, query.limit)
					.map(refOf),
			);
		},
		async read(id) {
			const found = deps.store.read((db) => resourceWork(db, id));
			if (!found) throw new Error("item_not_found");
			const { row } = found;
			const state = row.target_id
				? row.published_digest === hash(row.text)
					? `公開済み（${row.target_id}）`
					: `公開済み（${row.target_id}）、未公開の変更あり`
				: "未公開の下書き";
			const lines = [
				`パイプライン: ${row.title || UNTITLED}`,
				`状態: ${state}`,
				`版: ${row.revision}`,
			];
			const checked = row.text ? checkText(row.text) : null;
			if (!checked) lines.push("定義はまだありません");
			else if (!checked.ok) lines.push("定義は形式の検査を通っていません");
			else {
				const d = checked.value;
				if (d.summary) lines.push(`概要: ${d.summary}`);
				const inputs = Object.entries(d.inputs);
				if (inputs.length)
					lines.push(
						`入力: ${inputs
							.map(
								([name, i]) =>
									`${name}（${i.type}${i.required ? "、必須" : ""}）`,
							)
							.join("、")}`,
					);
				lines.push("手順:");
				d.steps.forEach((step, index) =>
					lines.push(
						`${index + 1}. ${step.title}${step.kind === "toolchain" ? `（${step.toolchain}）` : ""}`,
					),
				);
				if (d.answer) lines.push(`答え: ${d.answer}`);
			}
			return { text: headWithin(lines.join("\n"), READ_TOKEN_LIMIT).text };
		},
	};
}
