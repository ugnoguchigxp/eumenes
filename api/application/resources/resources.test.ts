import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import {
	createContinuityService,
	eventsMigration,
	itemSourceMigration,
	migration,
	shortTermMigration,
} from "../../domains/continuity";
import {
	combineKindAdapters,
	type ResourceKind,
	type SearchResourcesResponse,
	type ResolveResourceResponse,
} from "../../domains/resources";
import { harness, request } from "../../domains/shell/test/shell.fixture";
import { openStore } from "../../infrastructure/sqlite";
import { registerResourceRoutes } from ".";
import { createEventResourceAdapter } from "./adapters/event";
import { createResourceAccess } from "./access";
import { createShellResourceAdapter } from "./adapters/shell";

const signal = new AbortController().signal;
const kinds: ResourceKind[] = [
	{
		kind: "event",
		label: "会話の出来事",
		owner: "continuity",
		actions: ["read"],
		defaultAction: "read",
		actionLabels: { read: "内容を伝える" },
	},
	{
		kind: "code.task",
		label: "コード作業",
		owner: "shell",
		actions: ["open", "read"],
		defaultAction: "read",
		actionLabels: { open: "表示する", read: "内容を伝える" },
	},
];

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const clean of cleanups.splice(0)) await clean();
});

const at = (second: number) =>
	`2026-10-24T10:00:${String(second).padStart(2, "0")}+09:00`;

function eventHarness() {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-resources-"));
	const store = openStore(join(dir, "db.sqlite3"), [
		migration,
		shortTermMigration,
		itemSourceMigration,
		eventsMigration,
	]);
	cleanups.push(async () => {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	});
	const events = createContinuityService(store).events;
	const access = createResourceAccess({
		store,
		kinds: () => kinds,
		adapters: [
			createEventResourceAdapter({
				store,
				events,
				conversationIds: () => ["main"],
			}),
		],
	});
	return { store, events, access };
}

test("event: resolve and read a conversation event by <conversationId>:<eventId>", async () => {
	const { store, events, access } = eventHarness();
	const long = "長い".repeat(900);
	await store.write((db) => {
		events.appendInTransaction(db, {
			conversationId: "main",
			at: at(1),
			type: "said",
			by: "user",
			fields: { text: "明日の天気を教えて" },
		});
		events.appendInTransaction(db, {
			conversationId: "main",
			at: at(2),
			type: "said",
			by: "agent",
			fields: { text: long },
		});
	});
	const resolved = access.resolve("eumenes://event/main%3Ae1");
	expect(resolved).toMatchObject({
		ok: true,
		resource: {
			uri: "eumenes://event/main%3Ae1",
			kind: "event",
			kindLabel: "会話の出来事",
			label: "明日の天気を教えて",
			createdAt: at(1),
			actions: ["read"],
			targetRef: "main:e1",
		},
	});
	const read = await store.read((db) =>
		access.registry.read(db, "eumenes://event/main%3Ae1", signal),
	);
	expect(read).toMatchObject({ ok: true });
	expect(read.ok && read.text).toContain("明日の天気を教えて");
	expect(read.ok && read.text).toContain('"id":"e1"');
	// An event line is shortened by its owner to the read budget.
	const longRead = await store.read((db) =>
		access.registry.read(db, "eumenes://event/main%3Ae2", signal),
	);
	expect(longRead.ok && longRead.text.length).toBeLessThan(long.length);
	expect(access.resolve("eumenes://event/main%3Ae9")).toEqual({
		ok: false,
		code: "item_not_found",
	});
	for (const id of ["main", "main%3Ax1", "%3Ae1", "main%3Ae0x"])
		expect(access.resolve(`eumenes://event/${id}`)).toEqual({
			ok: false,
			code: "item_not_found",
		});
	expect(access.resolve("eumenes://event/main%3Ae1?action=read").ok).toBe(true);
});

test("event: search sees logged lines newest first, by text and time, and not forgotten ones", async () => {
	const { store, events, access } = eventHarness();
	await store.write((db) => {
		for (const [i, text] of ["天気の話", "音楽の話", "天気の続き"].entries())
			events.appendInTransaction(db, {
				conversationId: "main",
				at: at(i + 1),
				type: "said",
				by: "user",
				fields: { text },
				messageIds: [`m${i + 1}`],
			});
		events.appendInTransaction(db, {
			conversationId: "main",
			at: at(4),
			type: "said",
			by: "user",
			fields: { text: "保留中" },
			pending: true,
		});
		events.appendInTransaction(db, {
			conversationId: "other",
			at: at(5),
			type: "said",
			by: "user",
			fields: { text: "天気 別の会話" },
		});
	});
	const uris = async (query: Parameters<typeof access.search>[0]) =>
		(await access.search(query, signal)).resources.map((r) => r.uri);
	expect(await uris({ text: "", limit: 10 })).toEqual([
		"eumenes://event/main%3Ae3",
		"eumenes://event/main%3Ae2",
		"eumenes://event/main%3Ae1",
	]);
	expect(await uris({ text: "天気", limit: 10 })).toEqual([
		"eumenes://event/main%3Ae3",
		"eumenes://event/main%3Ae1",
	]);
	expect(await uris({ text: "", limit: 1, kind: "会話の出来事" })).toEqual([
		"eumenes://event/main%3Ae3",
	]);
	expect(
		await uris({ text: "", limit: 10, since: at(2), until: at(2) }),
	).toEqual(["eumenes://event/main%3Ae2"]);
	expect(await uris({ text: "", limit: 10, kind: "コード作業" })).toEqual([]);
	expect(await uris({ text: "", limit: 10, kind: "未登録" })).toEqual([]);
	await store.write((db) =>
		events.forgetMessagesInTransaction(db, ["m3"], at(9)),
	);
	expect(await uris({ text: "天気", limit: 10 })).toEqual([
		"eumenes://event/main%3Ae1",
	]);
	expect(access.resolve("eumenes://event/main%3Ae3")).toEqual({
		ok: false,
		code: "item_not_found",
	});
});

test("shell: a run is a code.task resource with the shell prefix, found, read and produced from a receipt", async () => {
	const h = harness();
	cleanups.push(() => h.close());
	const first = request({ task: "状態の確認", command: "git status --short" });
	const second = request({ task: "テストの実行", command: "bun test" });
	await h.enqueue(first);
	await h.enqueue(second);
	await h.shell.recover();
	const adapter = createShellResourceAdapter({
		store: h.store,
		shell: h.shell,
	});
	const access = createResourceAccess({
		store: h.store,
		kinds: () => kinds,
		adapters: [
			combineKindAdapters("code.task", [{ prefix: "shell", adapter }]),
		],
	});
	const uri = `eumenes://code.task/shell%3A${first.attemptId}`;
	expect(access.resolve(uri)).toMatchObject({
		ok: true,
		resource: {
			uri,
			label: "状態の確認",
			kindLabel: "コード作業",
			defaultAction: "read",
			actions: ["read", "open"],
			adapterRef: "artifact:cli.workspace@1",
		},
	});
	expect(access.resolve(`eumenes://code.task/${first.attemptId}`)).toEqual({
		ok: false,
		code: "item_not_found",
	});
	const read = await h.store.read((db) =>
		access.registry.read(db, uri, signal),
	);
	expect(read.ok && read.text).toContain("task: 状態の確認");
	expect(read.ok && read.text).toContain("command: git status --short");
	const found = await access.search({ text: "bun", limit: 5 }, signal);
	expect(found.resources.map((r) => [r.uri, r.kindLabel])).toEqual([
		[`eumenes://code.task/shell%3A${second.attemptId}`, "コード作業"],
	]);
	expect(
		(await access.search({ text: "", limit: 5 }, signal)).resources,
	).toHaveLength(2);
	// Results of a finished work: the run receipt or the run itself; a missing run produces nothing.
	const refs = (result: unknown) =>
		h.store.read((db) =>
			adapter.fromResultInTransaction(db, result, { conversationId: "main" }),
		);
	expect(
		refs({ attemptId: first.attemptId, task: "状態の確認" }).map((r) => r.uri),
	).toEqual([uri]);
	expect(refs({ output: { id: first.attemptId } }).map((r) => r.uri)).toEqual([
		uri,
	]);
	expect(refs({ attemptId: crypto.randomUUID() })).toEqual([]);
	expect(refs("nothing")).toEqual([]);
	expect(refs(null)).toEqual([]);
});

test("HTTP: resolve and search map to the contract shapes and reject bad queries", async () => {
	const h = harness();
	cleanups.push(() => h.close());
	const run = request({ task: "状態の確認" });
	await h.enqueue(run);
	await h.shell.recover();
	const access = createResourceAccess({
		store: h.store,
		kinds: () => kinds,
		adapters: [createShellResourceAdapter({ store: h.store, shell: h.shell })],
	});
	const app = new Hono();
	registerResourceRoutes(app, { access });
	const uri = `eumenes://code.task/shell%3A${run.attemptId}`;
	const resolve = (value?: string) =>
		app.request(
			`/api/resources/resolve${value === undefined ? "" : `?uri=${encodeURIComponent(value)}`}`,
		);
	const ok = await resolve(uri);
	expect(ok.status).toBe(200);
	expect(((await ok.json()) as ResolveResourceResponse).ok).toBe(true);
	const missing = await resolve("eumenes://code.task/shell%3Anope");
	expect(missing.status).toBe(404);
	expect(await missing.json()).toEqual({ ok: false, code: "item_not_found" });
	expect((await resolve("eumenes://nothing/a")).status).toBe(404);
	const invalid = await resolve("not a uri");
	expect(invalid.status).toBe(400);
	expect(await invalid.json()).toEqual({
		ok: false,
		code: "resource_uri_invalid",
	});
	expect((await resolve()).status).toBe(400);

	const search = async (query: string) => app.request(`/api/resources${query}`);
	const listed = (await (
		await search("?query=確認&kind=コード作業")
	).json()) as SearchResourcesResponse;
	expect(listed.resources.map((r) => r.uri)).toEqual([uri]);
	expect(listed.resources[0]!.kindLabel).toBe("コード作業");
	expect(
		(
			(await (
				await search("?kind=code.task&limit=1")
			).json()) as SearchResourcesResponse
		).resources,
	).toHaveLength(1);
	expect(
		((await (await search("?query=none")).json()) as SearchResourcesResponse)
			.resources,
	).toEqual([]);
	for (const bad of [
		"?limit=0",
		"?limit=11",
		"?limit=x",
		"?since=yesterday",
		"?until=2026-10-01",
		"?extra=1",
	])
		expect((await search(bad)).status).toBe(400);
});
