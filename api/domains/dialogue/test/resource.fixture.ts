import {
	createResourceRegistry,
	formatResourceUri,
	type ResourceAdapter,
	type ResourceKind,
	type ResourceView,
} from "../../resources";
import type { ResourceAccess } from "../service/resource-ledger";

const WORDS = { open: "表示する", play: "再生する", read: "内容を伝える" };

export const IMAGE_KIND: ResourceKind = {
	kind: "image",
	label: "画像",
	owner: "image",
	actions: ["open", "read"],
	defaultAction: "open",
	actionLabels: WORDS,
};
export const TRACK_KIND: ResourceKind = {
	kind: "music.track",
	label: "曲",
	owner: "music",
	actions: ["open", "play", "read"],
	defaultAction: "play",
	actionLabels: WORDS,
};

type Item = { kind: string; label: string; createdAt: string; text: string };

/**
 * Resources the way their owners keep them, as plain data: the registry is the real one, the adapters read this
 * map. A result carries the id of the resource it made (`{ resourceId }`), the way an owner's record does.
 */
export function fakeResources(
	produces: Record<string, string[]> = {
		"fake.image": ["image"],
		"fake.music": ["music.track"],
	},
) {
	const items = new Map<string, Item>();
	const kinds = [IMAGE_KIND, TRACK_KIND];
	const adapter = (kind: ResourceKind): ResourceAdapter => ({
		kind: kind.kind,
		fromResultInTransaction: (_db, result) => {
			const id = (result as { resourceId?: unknown } | null)?.resourceId;
			const item = typeof id === "string" ? items.get(id) : undefined;
			return item && item.kind === kind.kind && typeof id === "string"
				? [
						{
							uri: formatResourceUri(kind.kind, id),
							kind: kind.kind,
							label: item.label,
							createdAt: item.createdAt,
						},
					]
				: [];
		},
		getInTransaction: (_db, id): ResourceView | null => {
			const item = items.get(id);
			if (!item || item.kind !== kind.kind) return null;
			return {
				uri: formatResourceUri(kind.kind, id),
				kind: kind.kind,
				label: item.label,
				createdAt: item.createdAt,
				adapterRef: kind.owner,
				targetRef: id,
				actions: [
					kind.defaultAction,
					...kind.actions.filter((action) => action !== kind.defaultAction),
				],
			};
		},
		search: async () => [],
		read: async (id) => ({ text: items.get(id)?.text ?? "" }),
	});
	const access: ResourceAccess = {
		registry: createResourceRegistry({
			kinds: () => kinds,
			adapters: kinds.map(adapter),
		}),
		producesInTransaction: (_db, toolchainId) => produces[toolchainId] ?? [],
	};
	return {
		access,
		/** The owner makes a resource; returns its URI. */
		make(
			kind: string,
			id: string,
			label: string,
			createdAt = "2026-10-25T01:00:00.000Z",
			text = label,
		) {
			items.set(id, { kind, label, createdAt, text });
			return formatResourceUri(kind, id);
		},
		/** The owner deletes it. */
		remove(id: string) {
			items.delete(id);
		},
	};
}
