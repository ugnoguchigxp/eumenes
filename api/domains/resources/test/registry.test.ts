import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import {
	combineKindAdapters,
	createResourceRegistry,
	formatResourceUri,
	type ResourceAction,
	type ResourceAdapter,
	type ResourceKind,
	type ResourceRef,
	type ResourceSearch,
} from "..";

const db = new Database(":memory:");
const signal = new AbortController().signal;

const kind = (
	name: string,
	actions: ResourceAction[],
	defaultAction: ResourceAction,
): ResourceKind => ({
	kind: name,
	label: `label-${name}`,
	owner: "owner",
	actions,
	defaultAction,
	actionLabels: { open: "表示する", play: "再生する", read: "内容を伝える" },
});

const ref = (k: string, id: string, createdAt: string): ResourceRef => ({
	uri: formatResourceUri(k, id),
	kind: k,
	label: `${k} ${id}`,
	createdAt,
});

/** An owner with a fixed set of items; `viewActions` is what the owner lists for each. */
function owner(
	name: string,
	items: Record<string, string>,
	viewActions: ResourceAction[] = ["open", "play", "read"],
	extra: Partial<ResourceAdapter> = {},
) {
	const searches: ResourceSearch[] = [];
	const adapter: ResourceAdapter = {
		kind: name,
		fromResultInTransaction: () => [],
		getInTransaction: (_db, id) =>
			items[id]
				? {
						...ref(name, id, items[id]),
						adapterRef: `adapter:${name}`,
						targetRef: `target:${id}`,
						actions: viewActions,
					}
				: null,
		async search(query) {
			searches.push(query);
			return Object.entries(items)
				.map(([id, at]) => ref(name, id, at))
				.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
				.slice(0, query.limit);
		},
		read: async (id) => ({ text: `text of ${id}\n${"x".repeat(5000)}` }),
		...extra,
	};
	return { adapter, searches };
}

const kinds = [
	kind("image", ["open", "read"], "open"),
	kind("music.track", ["open", "play", "read"], "play"),
	kind("report", ["open", "read"], "read"),
];

function fixture() {
	const image = owner("image", {
		a: "2026-10-01T00:00:00.000Z",
		b: "2026-10-03T00:00:00.000Z",
	});
	const track = owner(
		"music.track",
		{ t: "2026-10-02T00:00:00.000Z" },
		["read", "play", "open"],
		{
			prepareInTransaction: (_db, id, action) => ({
				adapterRef: "adapter:playlist",
				targetRef: `playlist-of-${id}-${action}`,
			}),
		},
	);
	const report = owner("report", { r: "2026-10-04T00:00:00.000Z" }, ["open"]);
	const registry = createResourceRegistry({
		kinds: () => kinds,
		adapters: [image.adapter, track.adapter, report.adapter],
	});
	return { registry, image, track, report };
}

test("resolve returns the view with the default action first, limited to kind and owner", () => {
	const { registry } = fixture();
	const track = registry.resolveInTransaction(db, "eumenes://music.track/t");
	expect(track).toMatchObject({
		ok: true,
		resource: {
			uri: "eumenes://music.track/t",
			kind: "music.track",
			kindLabel: "label-music.track",
			defaultAction: "play",
			actions: ["play", "open", "read"],
			adapterRef: "adapter:music.track",
			targetRef: "target:t",
		},
	});
	// The report owner lists only `open`, so `read` (the kind default) is not offered.
	const report = registry.resolveInTransaction(db, "eumenes://report/r");
	expect(report).toMatchObject({ ok: true, resource: { actions: ["open"] } });
	// The image owner lists play, but the kind does not allow it.
	const image = registry.resolveInTransaction(
		db,
		"eumenes://image/a?action=open",
	);
	expect(image).toMatchObject({
		ok: true,
		resource: { uri: "eumenes://image/a", actions: ["open", "read"] },
	});
});

test("resolve reports each error code", () => {
	const { registry } = fixture();
	for (const [uri, code] of [
		["not a uri", "resource_uri_invalid"],
		["eumenes://image/a?action=bogus", "resource_uri_invalid"],
		["eumenes://nothing/a", "resource_kind_unknown"],
		["eumenes://image/zzz", "item_not_found"],
	] as const)
		expect(registry.resolveInTransaction(db, uri)).toEqual({ ok: false, code });
});

test("a registered kind without an owner is unknown, and a duplicate owner is refused", () => {
	const image = owner("image", { a: "2026-10-01T00:00:00.000Z" }).adapter;
	const registry = createResourceRegistry({
		kinds: () => kinds,
		adapters: [image],
	});
	expect(registry.resolveInTransaction(db, "eumenes://report/r")).toEqual({
		ok: false,
		code: "resource_kind_unknown",
	});
	expect(registry.adapter("report")).toBeNull();
	expect(registry.kind("report")?.label).toBe("label-report");
	expect(() =>
		createResourceRegistry({ kinds: () => kinds, adapters: [image, image] }),
	).toThrow("resource_adapter_duplicate:image");
});

test("kinds are read on every call", () => {
	let current = kinds.slice(0, 1);
	const image = owner("image", { a: "2026-10-01T00:00:00.000Z" }).adapter;
	const registry = createResourceRegistry({
		kinds: () => current,
		adapters: [image],
	});
	expect(registry.resolveInTransaction(db, "eumenes://image/a").ok).toBe(true);
	current = [];
	expect(registry.resolveInTransaction(db, "eumenes://image/a")).toEqual({
		ok: false,
		code: "resource_kind_unknown",
	});
});

test("search merges kinds newest first, caps at the limit and passes the clamped limit down", async () => {
	const { registry, image, track, report } = fixture();
	const all = await registry.search({ text: "q", limit: 3 }, signal);
	expect(all.map((r) => r.uri)).toEqual([
		"eumenes://report/r",
		"eumenes://image/b",
		"eumenes://music.track/t",
	]);
	expect(image.searches[0]).toEqual({ text: "q", limit: 3 });
	const named = await registry.search(
		{ text: "", limit: 10, kinds: ["image", "music.track", "unknown"] },
		signal,
	);
	expect(named.map((r) => r.uri)).toEqual([
		"eumenes://image/b",
		"eumenes://music.track/t",
		"eumenes://image/a",
	]);
	expect(report.searches).toHaveLength(1);
	expect((await registry.search({ text: "", limit: 0 }, signal)).length).toBe(
		1,
	);
	await registry.search({ text: "", limit: 99 }, signal);
	expect(track.searches.at(-1)?.limit).toBe(10);
	expect(image.searches.at(-1)?.limit).toBe(10);
});

test("read returns the owner's text unchanged and checks the action", async () => {
	const { registry } = fixture();
	const read = await registry.read(db, "eumenes://image/a", signal);
	expect(read).toEqual({
		ok: true,
		text: `text of a\n${"x".repeat(5000)}`,
	});
	expect(await registry.read(db, "eumenes://report/r", signal)).toEqual({
		ok: false,
		code: "action_not_allowed",
	});
	expect(await registry.read(db, "eumenes://image/zzz", signal)).toEqual({
		ok: false,
		code: "item_not_found",
	});
	expect(await registry.read(db, "eumenes://nothing/a", signal)).toEqual({
		ok: false,
		code: "resource_kind_unknown",
	});
	expect(await registry.read(db, "bad", signal)).toEqual({
		ok: false,
		code: "resource_uri_invalid",
	});
});

test("prepare checks the action against the kind, then the owner's preparation or the view's refs", () => {
	const { registry } = fixture();
	expect(
		registry.prepareInTransaction(db, "eumenes://music.track/t", "play", {
			conversationId: "main",
		}),
	).toEqual({
		ok: true,
		adapterRef: "adapter:playlist",
		targetRef: "playlist-of-t-play",
	});
	expect(
		registry.prepareInTransaction(db, "eumenes://image/a", "open", {
			conversationId: "main",
		}),
	).toEqual({ ok: true, adapterRef: "adapter:image", targetRef: "target:a" });
	// The kind does not allow play: refused even for an item that does not exist.
	expect(
		registry.prepareInTransaction(db, "eumenes://image/a", "play", {
			conversationId: "main",
		}),
	).toEqual({ ok: false, code: "action_not_allowed" });
	expect(
		registry.prepareInTransaction(db, "eumenes://image/zzz", "play", {
			conversationId: "main",
		}),
	).toEqual({ ok: false, code: "action_not_allowed" });
	expect(
		registry.prepareInTransaction(db, "eumenes://image/zzz", "open", {
			conversationId: "main",
		}),
	).toEqual({ ok: false, code: "item_not_found" });
	// The kind allows read but the report owner does not list it.
	expect(
		registry.prepareInTransaction(db, "eumenes://report/r", "read", {
			conversationId: "main",
		}),
	).toEqual({ ok: false, code: "action_not_allowed" });
	expect(
		registry.prepareInTransaction(db, "eumenes://nothing/a", "open", {
			conversationId: "main",
		}),
	).toEqual({ ok: false, code: "resource_kind_unknown" });
	expect(
		registry.prepareInTransaction(db, "bad", "open", {
			conversationId: "main",
		}),
	).toEqual({
		ok: false,
		code: "resource_uri_invalid",
	});
});

test("one kind owned by several domains is routed by the id prefix", async () => {
	const shellItems = { "shell:1": "2026-10-05T00:00:00.000Z" };
	const kanbanItems = { "kanban:9": "2026-10-06T00:00:00.000Z" };
	const combined = combineKindAdapters("image", [
		{ prefix: "shell", adapter: owner("image", shellItems).adapter },
		{
			prefix: "kanban",
			adapter: owner("image", kanbanItems, ["open", "read"], {
				prepareInTransaction: () => ({ adapterRef: "k", targetRef: "k" }),
			}).adapter,
		},
	]);
	const registry = createResourceRegistry({
		kinds: () => kinds,
		adapters: [combined],
	});
	expect(
		registry.resolveInTransaction(db, "eumenes://image/shell%3A1").ok,
	).toBe(true);
	expect(
		registry.resolveInTransaction(db, "eumenes://image/other%3A1"),
	).toEqual({ ok: false, code: "item_not_found" });
	expect(
		(await registry.search({ text: "", limit: 5 }, signal)).map((r) => r.uri),
	).toEqual(["eumenes://image/kanban%3A9", "eumenes://image/shell%3A1"]);
	expect(
		registry.prepareInTransaction(db, "eumenes://image/shell%3A1", "open", {
			conversationId: "main",
		}),
	).toEqual({
		ok: true,
		adapterRef: "adapter:image",
		targetRef: "target:shell:1",
	});
	expect(
		registry.prepareInTransaction(db, "eumenes://image/kanban%3A9", "open", {
			conversationId: "main",
		}),
	).toEqual({ ok: true, adapterRef: "k", targetRef: "k" });
});
