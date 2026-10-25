import type { Database } from "bun:sqlite";
import { z } from "zod";
import { headWithin } from "../../../infrastructure/context-budget";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import {
	formatResourceUri,
	RESOURCE_LABEL_MAX,
	type ResourceAdapter,
	type ResourceRef,
	type ResourceView,
} from "../../resources";
import type { ImageRecord } from "../contracts";
import { imageByArtifact, imageGenerations } from "../repository";
import { importedArtifact, importedArtifacts } from "../repository/imports";

export const IMAGE_RESOURCE_KIND = "image";
export const IMAGE_SCREEN_ADAPTER_REF = "adapter:image-screen@1";
const READ_TOKEN_LIMIT = 600;

/** What the image toolchain reports: the reference of a run, or the generation record itself. */
const imageResult = z.looseObject({
	state: z.string(),
	imageRef: z.string().nullish(),
	artifactId: z.string().nullish(),
});

const iso = (ms: number) => new Date(ms).toISOString();
const contentUrl = (imageRef: string) =>
	`/api/images/${encodeURIComponent(imageRef)}/content`;
const labelOf = (text: string, fallback: string) =>
	text.trim().slice(0, RESOURCE_LABEL_MAX).trim() || fallback;
const importLabel = (createdAt: string) => `画像 ${createdAt.slice(0, 10)}`;

type Found =
	| { source: "generation"; record: ImageRecord; imageRef: string }
	| {
			source: "import";
			imageRef: string;
			createdAt: string;
			width: number;
			height: number;
			format: string;
	  };

const importedFound = (a: {
	id: string;
	createdAt: string;
	width: number;
	height: number;
	format: string;
}): Found => ({
	source: "import",
	imageRef: a.id,
	createdAt: a.createdAt,
	width: a.width,
	height: a.height,
	format: a.format,
});

function find(db: Database, imageRef: string): Found | null {
	const record = imageByArtifact(db, imageRef);
	if (record) return { source: "generation", record, imageRef };
	const imported = importedArtifact(db, imageRef);
	return imported ? importedFound(imported) : null;
}

const refOf = (found: Found): ResourceRef => ({
	uri: formatResourceUri(IMAGE_RESOURCE_KIND, found.imageRef),
	kind: IMAGE_RESOURCE_KIND,
	label:
		found.source === "generation"
			? labelOf(found.record.title, "画像")
			: importLabel(found.createdAt),
	createdAt:
		found.source === "generation"
			? iso(found.record.createdAt)
			: new Date(found.createdAt).toISOString(),
});

/** The `image` kind: generated images (completed generations) and imported ones, by the library's image id. */
export function createImageResourceAdapter(deps: {
	store: SqliteStore;
}): ResourceAdapter {
	return {
		kind: IMAGE_RESOURCE_KIND,
		fromResultInTransaction(db, result) {
			const parsed = imageResult.safeParse(result);
			if (!parsed.success || parsed.data.state !== "completed") return [];
			const imageRef = parsed.data.imageRef ?? parsed.data.artifactId;
			if (!imageRef) return [];
			const found = find(db, imageRef);
			return found ? [refOf(found)] : [];
		},
		getInTransaction(db, id): ResourceView | null {
			const found = find(db, id);
			if (!found) return null;
			return {
				...refOf(found),
				adapterRef: IMAGE_SCREEN_ADAPTER_REF,
				targetRef: found.imageRef,
				actions: ["open", "read"],
				preview: contentUrl(found.imageRef),
			};
		},
		async search(query) {
			const text = query.text.trim().toLowerCase();
			const since = query.since ? Date.parse(query.since) : -Infinity;
			const until = query.until ? Date.parse(query.until) : Infinity;
			return deps.store.read((db) => {
				const hits: Array<{ at: number; ref: ResourceRef }> = [];
				const seen = new Set<string>();
				const add = (found: Found, haystack: string) => {
					if (seen.has(found.imageRef)) return;
					if (text && !haystack.toLowerCase().includes(text)) return;
					const ref = refOf(found);
					const at = Date.parse(ref.createdAt);
					if (at < since || at > until) return;
					seen.add(found.imageRef);
					hits.push({ at, ref });
				};
				for (const record of imageGenerations(db))
					add(
						{ source: "generation", record, imageRef: record.artifactId! },
						`${record.title}\n${record.description}\n${record.prompt ?? ""}`,
					);
				for (const imported of importedArtifacts(db)) {
					const found = importedFound(imported);
					add(found, importLabel(imported.createdAt));
				}
				return hits
					.sort((a, b) => b.at - a.at)
					.slice(0, query.limit)
					.map((hit) => hit.ref);
			});
		},
		async read(id) {
			const found = deps.store.read((db) => find(db, id));
			if (!found) throw new Error("item_not_found");
			const lines =
				found.source === "generation"
					? [
							`画像: ${found.record.title}`,
							found.record.description && `説明: ${found.record.description}`,
							found.record.prompt && `生成の依頼: ${found.record.prompt}`,
							found.record.width &&
								found.record.height &&
								`大きさ: ${found.record.width}x${found.record.height}${found.record.format ? ` ${found.record.format}` : ""}`,
						]
					: [
							importLabel(found.createdAt),
							"取り込んだ画像（生成の依頼はありません）",
							`大きさ: ${found.width}x${found.height} ${found.format}`,
						];
			return {
				text: headWithin(lines.filter(Boolean).join("\n"), READ_TOKEN_LIMIT)
					.text,
			};
		},
	};
}
