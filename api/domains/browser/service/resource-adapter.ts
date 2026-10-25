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
} from "../../resources";
import {
	readyCaptureWithTab,
	readyCapturesWithTab,
	type CaptureWithTab,
} from "../repository";

/** The browser screen; the target is the capture (the screen lists captures, plan section 9). */
const BROWSER_RESOURCE_ADAPTER_REF = "adapter:browser@1";
const KIND = "capture";
/** A search reads at most this many finished captures, newest first. */
const SEARCH_WINDOW = 500;
const READ_BUDGET_TOKENS = 560;
const MARK = "…（以下省略）";

const rangeLabel: Record<CaptureWithTab["range"], string> = {
	viewport: "表示中の範囲",
	"full-page": "ページ全体",
	element: "指定した要素",
};

/** The host of a page address; the path and query (which can carry secrets) are never read out. */
const hostOf = (url: string | null) => {
	if (!url) return null;
	try {
		return new URL(url).host || null;
	} catch {
		return null;
	}
};

const atOf = (c: CaptureWithTab) =>
	new Date(c.captured_at ?? c.created_at).toISOString();

/**
 * The capture kind (`capture`) over the domain's own finished captures (`local_ready`). The id is the capture
 * id; a capture that is still being taken, failed, cancelled or expired is not a resource.
 */
export function createBrowserResourceAdapter(deps: {
	store: SqliteStore;
	owner: string;
}): ResourceAdapter {
	const { store, owner } = deps;
	const labelOf = (c: CaptureWithTab) =>
		[
			...(c.tab_title?.trim()
				? `${c.tab_title.trim()}の撮影`
				: `ブラウザの撮影（${rangeLabel[c.range]}）`),
		]
			.slice(0, RESOURCE_LABEL_MAX)
			.join("");
	const refOf = (c: CaptureWithTab): ResourceRef => ({
		uri: formatResourceUri(KIND, c.id),
		kind: KIND,
		label: labelOf(c),
		createdAt: atOf(c),
	});
	return {
		kind: KIND,
		/** `result` is the capture as the domain reports it (`{ captureId, state }`); only a finished one counts. */
		fromResultInTransaction(db: Database, result: unknown) {
			if (!result || typeof result !== "object") return [];
			const id = (result as { captureId?: unknown }).captureId;
			if (typeof id !== "string" || !id) return [];
			const capture = readyCaptureWithTab(db, owner, id);
			return capture ? [refOf(capture)] : [];
		},
		getInTransaction(db: Database, id: string) {
			const capture = readyCaptureWithTab(db, owner, id);
			return capture
				? {
						...refOf(capture),
						adapterRef: BROWSER_RESOURCE_ADAPTER_REF,
						targetRef: capture.id,
						actions: ["open", "read"],
						preview: `/api/browser/captures/${encodeURIComponent(capture.id)}/content`,
					}
				: null;
		},
		async search(query: ResourceSearch) {
			const words = query.text.split(/\s+/).filter(Boolean);
			const since = query.since ? Date.parse(query.since) : null;
			const until = query.until ? Date.parse(query.until) : null;
			return store
				.read((db) => readyCapturesWithTab(db, owner, SEARCH_WINDOW))
				.filter((c) => {
					const at = c.captured_at ?? c.created_at;
					if (since !== null && at < since) return false;
					if (until !== null && at > until) return false;
					const haystack = [
						c.tab_title ?? "",
						hostOf(c.tab_url) ?? "",
						rangeLabel[c.range],
					].join(" ");
					return words.every((word) => haystack.includes(word));
				})
				.slice(0, query.limit)
				.map(refOf);
		},
		/** When, of which page (title and host only), how (range, size), and the capture's state; a long title is cut with a marker. */
		async read(id: string) {
			const c = store.read((db) => readyCaptureWithTab(db, owner, id));
			if (!c) throw new Error("item_not_found");
			const lines = [
				`撮影（${rangeLabel[c.range]}）`,
				`撮影: ${atOf(c)}`,
				`大きさ: ${c.png_width ?? 0}×${c.png_height ?? 0}`,
			];
			const host = hostOf(c.tab_url);
			if (host) lines.push(`ページ: ${host}`);
			const head = lines.join("\n");
			const title = c.tab_title?.trim();
			return {
				text: title
					? `${head}\nタイトル: ${headWithin(title, READ_BUDGET_TOKENS - estimateTextTokens(head) - 8, MARK).text}`
					: head,
			};
		},
	};
}
