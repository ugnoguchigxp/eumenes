import { headWithin } from "../../../infrastructure/context-budget";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import {
	formatResourceUri,
	RESOURCE_LABEL_MAX,
	type ResourceAdapter,
	type ResourceRef,
	type ResourceView,
} from "../../resources";
import { correctionPlainText, type OcrRecord } from "../contracts";
import {
	allDocuments,
	documentById,
	type DocumentRow,
} from "../repository/resources";

export const DOCUMENT_RESOURCE_KIND = "document";
export const OCR_SCREEN_ADAPTER_REF = "adapter:ocr@1";
const READ_TOKEN_LIMIT = 600;
const PREVIEW_CHARS = 80;

const iso = (ms: number) => new Date(ms).toISOString();
const labelOf = (text: string, fallback: string) =>
	text.trim().slice(0, RESOURCE_LABEL_MAX).trim() || fallback;

const object = (value: unknown): Record<string, unknown> | null =>
	typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;

/** The text the OCR read: one image's text, or each video frame's text with its time. */
function sourceText(source: OcrRecord) {
	const result = source.result;
	if (!result) return "";
	if (result.kind === "image") return result.text;
	return result.frames
		.filter((frame) => frame.text)
		.map((frame) => `${frame.timestampSeconds}秒: ${frame.text}`)
		.join("\n");
}

const textOf = (row: DocumentRow) =>
	row.type === "input"
		? sourceText(row.record)
		: row.record.result
			? correctionPlainText(row.record.result)
			: "";

const idOf = (row: DocumentRow) => row.record.id;
const createdAtMs = (row: DocumentRow) => row.record.createdAt;
const nameOf = (row: DocumentRow) =>
	row.type === "input" ? row.record.name : row.source.name;

const refOf = (row: DocumentRow): ResourceRef => ({
	uri: formatResourceUri(DOCUMENT_RESOURCE_KIND, idOf(row)),
	kind: DOCUMENT_RESOURCE_KIND,
	label: labelOf(
		row.type === "input" ? row.record.name : `${row.source.name}（校正）`,
		"文書",
	),
	createdAt: iso(createdAtMs(row)),
});

const stateLabel: Record<string, string> = {
	queued: "読み取りの順番待ち",
	starting: "読み取りを始めています",
	running: "読み取り中",
	cancelling: "取消中",
	cancelled: "取り消されました",
	failed: "読み取りに失敗しました",
	completed: "読み取り済み",
};

/** The documents of the OCR screen: the read inputs and their corrected texts, by the OCR record's id. */
export function createOcrResourceAdapter(deps: {
	store: SqliteStore;
}): ResourceAdapter {
	return {
		kind: DOCUMENT_RESOURCE_KIND,
		fromResultInTransaction(db, result) {
			const root = object(result);
			if (!root) return [];
			const ids = new Set<string>();
			const add = (id: unknown) => {
				if (typeof id === "string") ids.add(id);
			};
			add(root.id);
			add(object(root.receipt)?.id);
			if (Array.isArray(root.resultRefs))
				for (const ref of root.resultRefs) {
					const item = object(ref);
					if (item?.owner === "ocr") add(item.id);
				}
			const refs: ResourceRef[] = [];
			for (const id of ids) {
				const row = documentById(db, id);
				if (row?.record.state === "completed") refs.push(refOf(row));
			}
			return refs;
		},
		getInTransaction(db, id): ResourceView | null {
			const row = documentById(db, id);
			if (!row) return null;
			const text = textOf(row).replace(/\s+/g, " ").trim();
			return {
				...refOf(row),
				adapterRef: OCR_SCREEN_ADAPTER_REF,
				targetRef: row.type === "input" ? row.record.id : row.record.sourceId,
				actions: ["open", "read"],
				...(text ? { preview: text.slice(0, PREVIEW_CHARS) } : {}),
			};
		},
		async search(query) {
			const words = query.text.toLowerCase().split(/\s+/).filter(Boolean);
			const since = query.since ? Date.parse(query.since) : -Infinity;
			const until = query.until ? Date.parse(query.until) : Infinity;
			return deps.store.read((db) =>
				allDocuments(db)
					.filter((row) => {
						const at = createdAtMs(row);
						if (row.record.state !== "completed" || at < since || at > until)
							return false;
						const haystack = `${nameOf(row)}\n${textOf(row)}`.toLowerCase();
						return words.every((word) => haystack.includes(word));
					})
					.sort((a, b) => createdAtMs(b) - createdAtMs(a))
					.slice(0, query.limit)
					.map(refOf),
			);
		},
		async read(id) {
			const row = deps.store.read((db) => documentById(db, id));
			if (!row) throw new Error("item_not_found");
			const state = stateLabel[row.record.state] ?? row.record.state;
			if (row.type === "input") {
				const result = row.record.result;
				const header = [
					`文書: ${row.record.name}`,
					`状態: ${state}`,
					result &&
						(result.kind === "image"
							? `画像 ${result.width}x${result.height}、${result.lines.length}行`
							: `動画 ${result.frames.length}フレーム`),
				];
				const body = textOf(row);
				return {
					text: headWithin(
						[...header, body && "OCR原文:", body].filter(Boolean).join("\n"),
						READ_TOKEN_LIMIT,
					).text,
				};
			}
			const uncertain = (row.record.result?.blocks ?? []).filter(
				(block) => block.uncertain,
			).length;
			const header = [
				`校正済みの文書: ${row.source.name}`,
				`状態: ${state}`,
				uncertain > 0 && `不確かな箇所: ${uncertain}`,
			];
			const body = textOf(row);
			return {
				text: headWithin(
					[...header, body && "校正後の本文:", body].filter(Boolean).join("\n"),
					READ_TOKEN_LIMIT,
				).text,
			};
		},
	};
}
