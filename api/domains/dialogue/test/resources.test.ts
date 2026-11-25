import { afterEach, expect, test } from "bun:test";
import { Hono } from "hono";
import { waitFor } from "../../../infrastructure/wait-for";
import { registerDialogue } from "..";
import type { ConversationResourcesResponse } from "../../resources";
import { ValidationFailure } from "../../../infrastructure/validation-log";
import { forgetWorkResources } from "../repository/resources";
import { resolveDelegateRefs } from "../service/delegate-refs";
import { createResourceLedger } from "../service/resource-ledger";
import { INSTANT, choice, setup, type Harness } from "./generation.fixture";
import { fakeResources } from "./resource.fixture";
import { openDialogueStore, removeDialogueStore } from "./store.fixture";

/**
 * The conversation's resource ledger and what is built on it (spec resource-uri-implementation-plan-2026-10-25.md
 * sections 4.1, 4.2, 6.2, 7.1 and 9): the stable `a<n>` numbers, the resources an assignment made, the state and
 * `<now>` lines, the resources `delegate` hands over and the HTTP response.
 */
let h: Harness | undefined;
afterEach(async () => {
	await h?.close();
	h = undefined;
});

/** A clock that advances one minute per call: the ledger's `used_at` order is then decided. */
function steppingClock() {
	let at = Date.parse("2026-10-25T09:00:00.000Z");
	return () => new Date((at += 60_000)).toISOString();
}

function ledgerStore() {
	const { dir, store } = openDialogueStore("eumenes-resources-");
	let n = 0;
	const deps = { clock: steppingClock(), id: () => `id-${++n}` };
	return { dir, store, deps, ledger: createResourceLedger(deps) };
}

test("a resource keeps its number; the most recently used comes first; a forgotten one is hidden and returns under its number", async () => {
	const { dir, store, ledger } = ledgerStore();
	try {
		await store.write((db) => {
			const enter = (
				uri: string,
				source: "work" | "found" | "viewed" = "found",
			) =>
				ledger.enterInTransaction(db, {
					conversationId: "main",
					uri,
					kind: "image",
					label: uri,
					source,
				});
			const a = enter("eumenes://image/a");
			const b = enter("eumenes://image/b");
			expect([a.ref, b.ref]).toEqual([1, 2]);
			// The same URI is the same number, however often it is met.
			expect(enter("eumenes://image/a").ref).toBe(1);
			expect(ledger.byRefInTransaction(db, "main", "a2")?.uri).toBe(
				"eumenes://image/b",
			);
			expect(ledger.byRefInTransaction(db, "main", "a3")).toBeNull();
			expect(ledger.byRefInTransaction(db, "main", "t1")).toBeNull();
			expect(ledger.byRefInTransaction(db, "other", "a1")).toBeNull();
			// a was met again after b: it is the newest; touching b moves b to the top.
			expect(
				ledger.recentInTransaction(db, "main", 8).map((row) => row.ref),
			).toEqual([1, 2]);
			ledger.touchInTransaction(db, b.id);
			expect(
				ledger.recentInTransaction(db, "main", 8).map((row) => row.ref),
			).toEqual([2, 1]);
			// The TODO that made a resource becomes its origin; a later view keeps it.
			const made = enter("eumenes://image/c", "viewed");
			ledger.enterInTransaction(db, {
				conversationId: "main",
				uri: made.uri,
				kind: "image",
				label: "c",
				source: "work",
				workId: "work-1",
			});
			enter("eumenes://image/c", "viewed");
			expect(ledger.byRefInTransaction(db, "main", "a3")).toMatchObject({
				source: "work",
				workId: "work-1",
			});
			// Forgetting the TODO hides what it made; finding or viewing it again keeps it hidden, the number taken.
			forgetWorkResources(db, [{ id: "work-1" }], "2026-10-25T10:00:00.000Z");
			expect(ledger.byRefInTransaction(db, "main", "a3")).toBeNull();
			expect(
				ledger.recentInTransaction(db, "main", 8).map((row) => row.ref),
			).toEqual([2, 1]);
			expect(enter("eumenes://image/c", "found").forgottenAt).not.toBeNull();
			expect(ledger.byRefInTransaction(db, "main", "a3")).toBeNull();
			// A new TODO that makes it again brings it back under its number.
			ledger.enterInTransaction(db, {
				conversationId: "main",
				uri: made.uri,
				kind: "image",
				label: "c",
				source: "work",
				workId: "work-2",
			});
			expect(ledger.byRefInTransaction(db, "main", "a3")?.workId).toBe(
				"work-2",
			);
			expect(enter("eumenes://image/d").ref).toBe(4);
		});
	} finally {
		removeDialogueStore(dir);
	}
});

test("a message links resources in order, once each", async () => {
	const { dir, store, ledger } = ledgerStore();
	try {
		await store.write((db) => {
			const rows = ["a", "b", "c"].map((id) =>
				ledger.enterInTransaction(db, {
					conversationId: "main",
					uri: `eumenes://image/${id}`,
					kind: "image",
					label: id,
					source: "found",
				}),
			);
			ledger.linkMessageInTransaction(db, "m1", [rows[1]!.id, rows[0]!.id]);
			ledger.linkMessageInTransaction(db, "m1", [rows[0]!.id, rows[2]!.id]);
			expect(
				db
					.query(
						"SELECT resource_id AS id FROM dialogue_message_resources WHERE message_id = 'm1' ORDER BY ordinal",
					)
					.all(),
			).toEqual([
				{ id: rows[1]!.id },
				{ id: rows[0]!.id },
				{ id: rows[2]!.id },
			]);
		});
	} finally {
		removeDialogueStore(dir);
	}
});

test("delegate refs: a number in the ledger becomes a reference with the owner's text; an unknown or forgotten one is refused", async () => {
	const { dir, store, ledger } = ledgerStore();
	const resources = fakeResources();
	try {
		const uri = resources.make(
			"image",
			"image_1",
			"夜のドライブ",
			"2026-10-25T01:00:00.000Z",
			"夜の高速道路を走る車の絵",
		);
		await store.write((db) => {
			ledger.enterInTransaction(db, {
				conversationId: "main",
				uri,
				kind: "image",
				label: "夜のドライブ",
				source: "work",
				workId: "w1",
			});
			ledger.enterInTransaction(db, {
				conversationId: "main",
				uri: resources.make("image", "image_2", "朝の海"),
				kind: "image",
				label: "朝の海",
				source: "found",
			});
		});
		const full = { store, resources: resources.access, resourceLedger: ledger };
		const signal = new AbortController().signal;
		const resolved = await resolveDelegateRefs(
			full,
			"main",
			["a1", "a1"],
			signal,
		);
		expect(resolved.uris).toEqual([uri]);
		expect(resolved.references).toHaveLength(1);
		expect(resolved.references[0]).toMatchObject({
			ref: uri,
			owner: "image",
			id: "image_1",
			label: "夜のドライブ",
			kind: "resource",
			preview: "夜の高速道路を走る車の絵",
		});
		expect(
			(await resolveDelegateRefs(full, "main", undefined, signal)).references,
		).toEqual([]);
		const refusal = (names: string[]) =>
			resolveDelegateRefs(full, "main", names, signal).then(
				() => null,
				(error: unknown) => error,
			);
		const unknown = await refusal(["a1", "a9"]);
		expect(unknown).toBeInstanceOf(ValidationFailure);
		expect((unknown as ValidationFailure).message).toBe("unknown_resource");
		// Forgotten with its TODO: refused as if never shown.
		await store.write((db) =>
			forgetWorkResources(db, [{ id: "w1" }], "2026-10-25T12:00:00.000Z"),
		);
		expect(await refusal(["a1"])).toBeInstanceOf(ValidationFailure);
		// Deleted at its owner: refused too.
		resources.remove("image_2");
		expect(await refusal(["a2"])).toBeInstanceOf(ValidationFailure);
	} finally {
		removeDialogueStore(dir);
	}
});

/** A turn the router hands to the clock: its fill call shows `## State`. */
async function askTime(text = "東京は今何時？") {
	h!.state.steps.push(choice({ choice: INSTANT.id, inputs: { city: "東京" } }));
	return h!.say(text);
}

test("the resource on screen is shown in the state by its number and joins the ledger as viewed", async () => {
	const resources = fakeResources();
	h = await setup({ resources: resources.access });
	const uri = resources.make("music.track", "music_9", "日曜日の午後");
	h.state.steps.push(choice({ choice: INSTANT.id, inputs: { city: "東京" } }));
	const run = await h.dialogue.submit({
		requestId: crypto.randomUUID(),
		conversationId: "main",
		text: "この曲の街は今何時？",
		viewing: { resource: uri },
	});
	await waitFor(() => h!.dialogue.get(run.id)?.status === "completed");
	const last = h.state.calls[0]!.messages.at(-1)!.content;
	expect(last).toContain("提示中:\n- a1 曲「日曜日の午後」（画面に表示中）");
	expect(last).not.toContain("eumenes://");
});

test("a registered screen reaches normal talk through the public submit without an extra model call", async () => {
	const resources = fakeResources();
	const revision = "artifact:test.images@1";
	h = await setup({
		resources: resources.access,
		screenInTransaction: (_db, id) =>
			id === revision
				? {
						title: "画像一覧",
						variants: ["gallery"],
						defaultVariant: "gallery",
						adapterRefs: ["image"],
					}
				: null,
	});
	const uri = resources.make("image", "first", "最初の画像");
	const hono = new Hono();
	registerDialogue(hono, h.dialogue);
	const screen = {
		artifactRevisionId: revision,
		sessionId: crypto.randomUUID(),
		sequence: 1,
		observedAt: new Date().toISOString(),
		phase: "ready",
		selection: "selected",
	};
	async function submit(viewing?: unknown) {
		const response = await hono.request("/api/runs", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				requestId: crypto.randomUUID(),
				conversationId: "main",
				text: "いま何が見えている？",
				viewing,
			}),
		});
		expect(response.status).toBe(202);
		const { id } = (await response.json()) as { id: string };
		await waitFor(() => h!.dialogue.get(id)?.status === "completed");
	}
	h.state.steps.push(
		{ text: "画面を確認しました。" },
		{ text: "はい。" },
		{ text: "はい。" },
	);
	await submit({ screen, resource: uri });
	expect(h.state.calls).toHaveLength(1);
	const modelInput = h.state.calls[0]!.messages.at(-1)!.content;
	expect(modelInput).toContain("送信時の画面「画像一覧」");
	expect(modelInput).toContain("対象選択済み");
	expect(modelInput).toContain("a1 画像「最初の画像」");
	expect(modelInput).not.toContain(uri);
	await submit({ screen: { ...screen, variantId: "unknown" }, resource: uri });
	expect(h.state.calls).toHaveLength(2);
	expect(h.state.calls[1]!.messages.at(-1)!.content).not.toContain(
		"送信時の画面",
	);
	expect(h.state.calls[1]!.messages.at(-1)!.content).not.toContain(
		"最初の画像",
	);
	await submit();
	expect(h.state.calls).toHaveLength(3);
	expect(h.state.calls[2]!.messages.at(-1)!.content).not.toContain(
		"送信時の画面",
	);
});

test("the candidates tell what a toolchain makes, in the kinds' display names", async () => {
	const resources = fakeResources();
	h = await setup({
		resources: resources.access,
		cards: [{ ...INSTANT, produces: ["image"] }],
	});
	await askTime();
	const candidates = JSON.parse(h.state.calls[1]!.messages.at(-1)!.content);
	expect(candidates.candidates).toMatchObject([
		{ id: INSTANT.id, produces: ["画像"] },
	]);
});

/**
 * The resources an assignment made are entered under the agency's work root (`source = 'work'`), and its report shows
 * them as chips; forgetting the root hides them.
 */
test("the resources an assignment made are numbered under its work root, shown as chips of its report, and hidden when it is forgotten", async () => {
	const resources = fakeResources({});
	h = await setup({ resources: resources.access });
	const uri = resources.make("image", "image_1", "夜のドライブ");
	const ledger = createResourceLedger({
		clock: () => new Date().toISOString(),
		id: () => crypto.randomUUID(),
	});
	await h.store.write((db) => {
		ledger.enterLinksInTransaction(db, {
			conversationId: "main",
			workId: "root-1",
			links: [{ uri, kind: "image", label: "夜のドライブ" }],
		});
		ledger.linkMessageToWorkResourcesInTransaction(db, "main", "agency-1", [
			"root-1",
		]);
	});
	const hono = new Hono();
	registerDialogue(hono, h.dialogue);
	const get = async () =>
		(await (
			await hono.request("/api/conversations/main/resources")
		).json()) as ConversationResourcesResponse;
	expect(await get()).toEqual({
		resources: [
			{
				ref: "a1",
				uri,
				kind: "image",
				kindLabel: "画像",
				label: "夜のドライブ",
				actions: ["open", "read"],
				forgotten: false,
			},
		],
		messages: [{ messageId: "agency-1", uris: [uri] }],
	});
	// The conversation reads the number, never the URI.
	await askTime();
	expect(
		h.state.calls
			.flatMap((call) => call.messages)
			.some((m) => m.content.includes("eumenes://")),
	).toBe(false);
	await h.store.write((db) => {
		forgetWorkResources(db, [{ id: "root-1" }], new Date().toISOString());
	});
	expect(h.dialogue.conversationResources("main")).toEqual({
		resources: [],
		messages: [],
	});
});
