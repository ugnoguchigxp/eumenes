import type { Database } from "bun:sqlite";
import { estimateTextTokens } from "../../../infrastructure/context-budget";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import {
	formatResourceUri,
	RESOURCE_LABEL_MAX,
	type ResourceAdapter,
	type ResourceRef,
	type ResourceSearch,
	type ResourceView,
} from "../../resources";
import type { Model3dAsset } from "../contracts";
import { generationRow, knownAsset, recentAssets } from "../repository";

/** The screen that shows 3D models; the target is the asset (the screen's `focus`, plan section 9). */
const MODEL3D_RESOURCE_ADAPTER_REF = "adapter:model3d@1";
const KIND = "model3d.asset";
/** The index holds LARM's assets; a search reads at most this many, newest first. */
const SEARCH_WINDOW = 500;
/** `read` stays well inside 600 estimated tokens (the framing lines are counted too). */
const READ_BUDGET_TOKENS = 560;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown) =>
	typeof value === "string" && value ? value : null;

/** An instant as ISO text; LARM's own timestamp, or the epoch when it cannot be read. */
const isoOf = (value: string) => {
	const ms = Date.parse(value);
	return new Date(Number.isNaN(ms) ? 0 : ms).toISOString();
};

/**
 * `body` cut to what fits `budget` tokens together with `head`: a deliberate excerpt that ends with an
 * explicit marker, never a silent cut.
 */
function excerpt(head: string, body: string, budget: number) {
	if (!body) return head;
	let chars = [...body];
	while (
		chars.length > 0 &&
		estimateTextTokens(`${head}${chars.join("")}`) > budget
	)
		chars = chars.slice(0, Math.floor(chars.length * 0.8));
	const cut = chars.length < [...body].length;
	return `${head}${chars.join("")}${cut ? "…（以下省略）" : ""}`;
}

/**
 * The 3D model kind (`model3d.asset`) over the domain's local index of LARM's assets and its generations. The id
 * is LARM's asset id. Nothing is copied: a search and a view read the index, which the domain keeps in step with
 * LARM.
 */
export function createModel3dResourceAdapter(deps: {
	store: SqliteStore;
	/** The principal whose assets are offered (the same one the domain's commands run as). */
	owner: string;
}): ResourceAdapter {
	const { store, owner } = deps;
	const refOf = (asset: Model3dAsset): ResourceRef => ({
		uri: formatResourceUri(KIND, asset.id),
		kind: KIND,
		label:
			[...asset.title.trim()].slice(0, RESOURCE_LABEL_MAX).join("") ||
			"3Dモデル",
		createdAt: isoOf(asset.createdAt),
	});
	const viewOf = (asset: Model3dAsset): ResourceView => ({
		...refOf(asset),
		adapterRef: MODEL3D_RESOURCE_ADAPTER_REF,
		targetRef: asset.id,
		actions: ["open", "read"],
		preview: [
			...(asset.tags.length ? asset.tags.join("・") : (asset.prompt ?? "")),
		]
			.slice(0, 80)
			.join(""),
	});
	return {
		kind: KIND,
		/**
		 * `result` is a generation as the domain reports it (`{ id, ... }`, alone or as `{ generation }`) or a
		 * target (`{ assetRef }`). A generation counts when it is completed, not deleted, and its asset is in the index.
		 */
		fromResultInTransaction(db: Database, result: unknown) {
			if (!isRecord(result)) return [];
			const generation = isRecord(result.generation)
				? result.generation
				: result;
			const ids = new Set<string>();
			const generationId =
				text(generation.generationRef) ?? text(generation.id);
			if (generationId) {
				const row = generationRow(db, generationId);
				if (
					row &&
					row.owner === owner &&
					row.state === "completed" &&
					!row.deleted &&
					row.asset_id
				)
					ids.add(row.asset_id);
			}
			const assetRef = text(result.assetRef);
			if (assetRef) ids.add(assetRef);
			return [...ids].flatMap((id) => {
				const asset = knownAsset(db, owner, id);
				return asset ? [refOf(asset)] : [];
			});
		},
		getInTransaction(db: Database, id: string) {
			const asset = knownAsset(db, owner, id);
			return asset ? viewOf(asset) : null;
		},
		async search(query: ResourceSearch) {
			const words = query.text.split(/\s+/).filter(Boolean);
			const since = query.since ? Date.parse(query.since) : null;
			const until = query.until ? Date.parse(query.until) : null;
			return store
				.read((db) => recentAssets(db, owner, SEARCH_WINDOW))
				.filter((asset) => {
					const at = Date.parse(isoOf(asset.createdAt));
					if (since !== null && at < since) return false;
					if (until !== null && at > until) return false;
					const haystack = [
						asset.title,
						...asset.tags,
						asset.prompt ?? "",
					].join(" ");
					return words.every((word) => haystack.includes(word));
				})
				.slice(0, query.limit)
				.map(refOf);
		},
		/** The title, the creation time, the tags, the request (the index keeps its first 120 characters) and warnings. */
		async read(id: string) {
			const asset = store.read((db) => knownAsset(db, owner, id));
			if (!asset) throw new Error("item_not_found");
			const lines = [
				`3Dモデル「${asset.title}」`,
				`作成: ${isoOf(asset.createdAt)}`,
				`タグ: ${asset.tags.length ? asset.tags.join("、") : "なし"}`,
			];
			if (asset.warnings.length)
				lines.push(
					`注意: ${asset.warnings
						.slice(0, 2)
						.map((warning) => [...warning].slice(0, 80).join(""))
						.join(" / ")}`,
				);
			return {
				text: asset.prompt
					? excerpt(
							`${lines.join("\n")}\n依頼: `,
							asset.prompt,
							READ_BUDGET_TOKENS,
						)
					: lines.join("\n"),
			};
		},
	};
}
