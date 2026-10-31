import { afterEach, expect, test } from "bun:test";
import { Hono } from "hono";
import { waitFor } from "../../../infrastructure/wait-for";
import { registerDialogue } from "..";
import type { ConversationResourcesResponse } from "../../resources";
import { ValidationFailure } from "../../../infrastructure/validation-log";
import { insertWork, workById } from "../repository/work";
import {
	confirmationResourceUris,
	forgetWorkResources,
	saveConfirmationRefs,
	workLinksOf,
} from "../repository/resources";
import { resolveDelegateRefs } from "../service/delegate-refs";
import { createResourceLedger } from "../service/resource-ledger";
import { madeOf } from "../service/state-text";
import { createWorkLedger } from "../service/work-ledger";
import { recordWorkLinksInTransaction } from "../service/work-links";
import {
	IMAGE,
	MUSIC,
	choice,
	reply,
	setup,
	type Harness,
} from "./generation.fixture";
import { fakeResources } from "./resource.fixture";
import { openDialogueStore, removeDialogueStore } from "./store.fixture";

/**
 * The conversation's resource ledger and what is built on it (spec resource-uri-implementation-plan-2026-10-25.md
 * sections 4.1, 4.2, 6.2, 7.1 and 9): the stable `a<n>` numbers, the links a finished TODO keeps, the state and
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

test("an image result becomes the TODO's link, which the state names by its number", async () => {
	const { dir, store, deps, ledger } = ledgerStore();
	const resources = fakeResources();
	try {
		const uri = resources.make("image", "image_1", "夜のドライブ");
		const track = resources.make("music.track", "music_1", "日曜日の午後");
		await store.write((db) => {
			const full = {
				...deps,
				resources: resources.access,
				resourceLedger: ledger,
			};
			const work = createWorkLedger({
				...full,
				continuity: undefined as never,
				toolchains: undefined,
			});
			const row = insertWork(db, {
				id: "work-3",
				conversationId: "main",
				runId: "run-1",
				toolchainId: "fake.image",
				toolchainRevisionId: "toolchain:fake.image@1",
				execution: "image",
				request: "夜のドライブの絵",
				title: "夜のドライブの絵",
				sourceRef: null,
				dedupeKey: "k1",
				createdAt: "2026-10-25T09:00:00.000Z",
				messageIds: [],
			});
			const links = recordWorkLinksInTransaction(
				full,
				db,
				row,
				{ state: "completed", resourceId: "image_1" },
				{ conversationId: "main", runId: "run-1", workId: row.id },
			);
			expect(links).toEqual([{ uri, kind: "image", label: "夜のドライブ" }]);
			expect(workLinksOf(db, [row.id]).get(row.id)).toEqual(links);
			// A track found in the history joins the ledger too.
			ledger.enterInTransaction(db, {
				conversationId: "main",
				uri: track,
				kind: "music.track",
				label: "日曜日の午後",
				source: "found",
			});
			// A result that names nothing the owner has makes no link; the sub-agent's links are checked.
			expect(
				recordWorkLinksInTransaction(
					full,
					db,
					{ ...row, id: "work-x" },
					{ resourceId: "missing" },
					{ conversationId: "main", workId: "work-x" },
					["eumenes://image/missing", "not a uri", track],
				),
			).toEqual([{ uri: track, kind: "music.track", label: "日曜日の午後" }]);
			const refs = work.refsInTransaction(db, "main");
			expect(refs.resource(uri)).toBe("a1");
			const [todo] = work.todosInTransaction(db, "main");
			// The TODO's line names what it made by number and name, never the URI.
			expect(madeOf(todo!, refs)).toEqual(["a1「夜のドライブ」"]);
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

/** An image TODO done with the resource its owner made, the way a finished job reports it. */
async function doneImage(resources: ReturnType<typeof fakeResources>) {
	const uri = resources.make("image", "image_1", "夜のドライブ");
	h!.state.steps.push(
		choice({
			choice: IMAGE.id,
			say: "描きますね。",
			request: "夜のドライブの絵",
		}),
	);
	const waiting = await h!.say("夜のドライブの絵を描いて", "queued");
	const done = await h!.finishImage(waiting.id, {
		state: "completed",
		title: "夜のドライブ",
		resourceId: "image_1",
	});
	return { uri, done };
}

/**
 * The lines of `## State` in the last message of the newest turn's choice call (the talk turn shows the time alone,
 * so the choice is where the TODOs and resources are named).
 */
const stateOfLastCall = () => {
	const last = h!.state.calls.at(-2)!.messages.at(-1)!.content;
	const start = last.indexOf("## State\n") + "## State\n".length;
	const end = last.indexOf("\n\n", start);
	return last.slice(start, end < 0 ? undefined : end).split("\n");
};

test("a finished image TODO links its image, its notice and a message citing it show it, and the next prompt shows its number", async () => {
	const resources = fakeResources({ [IMAGE.id]: ["image"], [MUSIC.id]: [] });
	h = await setup({ resources: resources.access });
	const { uri } = await doneImage(resources);
	const [todo] = h.archived();
	expect(todo).toMatchObject({ toolchainId: IMAGE.id });
	expect(h.notices().notices[0]).toMatchObject({
		id: todo!.id,
		links: [{ uri, kind: "image", label: "夜のドライブ" }],
	});
	const hono = new Hono();
	registerDialogue(hono, h.dialogue);
	const get = async () =>
		(await (
			await hono.request("/api/conversations/main/resources")
		).json()) as ConversationResourcesResponse;
	const image: ConversationResourcesResponse["resources"][number] = {
		ref: "a1",
		uri,
		kind: "image",
		kindLabel: "画像",
		label: "夜のドライブ",
		actions: ["open", "read"],
		forgotten: false,
	};
	expect(await get()).toEqual({ resources: [image], messages: [] });
	// The conversation reads the numbers, never the URI.
	h.state.steps.push(...reply("はい。"));
	await h.say("さっきの絵は？");
	const lines = stateOfLastCall();
	expect(lines).toContain("- t1 夜のドライブの絵 通知済み a1「夜のドライブ」");
	expect(
		h.state.calls
			.slice(-2)
			.flatMap((call) => call.messages)
			.some((m) => m.content.includes("eumenes://")),
	).toBe(false);
	// A reply is not a report: its notice told the work, so no reply shows the image as a chip.
	expect((await get()).messages).toEqual([]);
	// An agency utterance that cites the TODO is linked when it is stored.
	await h.store.write((db) =>
		h!.dialogue.recordSpontaneousInTransaction(db, {
			conversationId: "main",
			messageId: "agency-1",
			text: "絵ができました。",
			at: "2026-10-25T10:00:00.000Z",
			todoRefs: [todo!.id],
		}),
	);
	expect((await get()).messages).toContainEqual({
		messageId: "agency-1",
		uris: [uri],
	});
});

test("the resource on screen is shown in the state by its number and joins the ledger as viewed", async () => {
	const resources = fakeResources();
	h = await setup({ resources: resources.access });
	const uri = resources.make("music.track", "music_9", "日曜日の午後");
	h.state.steps.push(...reply("いい曲ですね。"));
	const run = await h.dialogue.submit({
		requestId: crypto.randomUUID(),
		conversationId: "main",
		text: "これ好き",
		viewing: { resource: uri },
	});
	await waitFor(() => h!.dialogue.get(run.id)?.status === "completed");
	const last = h.state.calls[0]!.messages.at(-1)!.content;
	expect(last).toContain("提示中:\n- a1 曲「日曜日の午後」（画面に表示中）");
	expect(last).not.toContain("eumenes://");
});

test("the candidates tell what a toolchain makes, in the kinds' display names", async () => {
	const resources = fakeResources();
	h = await setup({
		resources: resources.access,
		cards: [{ ...IMAGE, produces: ["image"] }],
	});
	h.state.steps.push(...reply("探しました。"));
	await h.say("絵を描ける？");
	const candidates = h.state.calls[0]!.messages.at(-1)!.content;
	expect(candidates).toContain(`- ${IMAGE.id}: `);
	expect(candidates).toContain("作るもの: 画像");
});

test("delegate refs are refused for a number the conversation never saw, and handed over for one it did", async () => {
	const resources = fakeResources({ [IMAGE.id]: ["image"] });
	h = await setup({ resources: resources.access });
	await doneImage(resources);
	const request = (refs: string[]) =>
		choice({
			choice: IMAGE.id,
			say: "描き直しますね。",
			request: "a1の絵を元に描き直して",
			refs,
		});
	// The refusal is told to the next choice as its reason; a choice refused twice leaves the host's words.
	h.state.steps.push(request(["a7"]), request(["a7"]));
	const refused = await h.say("あの絵を描き直して");
	const retry = h.state.calls.at(-1)!.messages.at(-1)!.content;
	expect(retry).toContain("## Retry");
	expect(retry).toContain("unknown_resource");
	expect(retry).not.toContain("eumenes://");
	expect(h.dialogue.answerText(refused.id)).toBe(
		"うまく頼めませんでした。もう一度言ってもらえますか。",
	);
	h.state.steps.push(request(["a1"]));
	const waiting = await h.say("a1を描き直して", "queued");
	expect(waiting.status).toBe("queued");
});

test("forgetting the messages a TODO came from empties its links and hides the resources it made", async () => {
	const resources = fakeResources({ [IMAGE.id]: ["image"] });
	h = await setup({ resources: resources.access });
	await doneImage(resources);
	const [todo] = h.archived();
	expect(h.notices().notices).toHaveLength(1);
	const messageIds = h.store.read((db) => workById(db, todo!.id)!.messageIds);
	expect(messageIds.length).toBeGreaterThan(0);
	await h.store.write((db) => {
		createWorkLedger({
			clock: () => new Date().toISOString(),
			id: () => crypto.randomUUID(),
			continuity: h!.continuity,
			toolchains: undefined,
		}).forgetInTransaction(db, messageIds);
	});
	expect(
		h.store.read((db) => workLinksOf(db, [todo!.id]).get(todo!.id)),
	).toBeUndefined();
	const response = h.dialogue.conversationResources("main");
	expect(response).toEqual({ resources: [], messages: [] });
	// A forgotten TODO's notice goes with it.
	expect(h.notices()).toEqual({ notices: [], unread: 0 });
	h.state.steps.push(...reply("はい。"));
	await h.say("さっきの絵は？");
	expect(stateOfLastCall().some((line) => line.startsWith("a1 "))).toBe(false);
	// A forgotten TODO is never named in the state, not even as notified.
	expect(stateOfLastCall().some((line) => line.startsWith("- t1 "))).toBe(
		false,
	);
});

test("the resources a confirmation was issued with are kept with it", async () => {
	const { dir, store } = ledgerStore();
	try {
		await store.write((db) => {
			db.query(
				"INSERT INTO dialogue_confirmations (id, conversation_id, toolchain_id, toolchain_revision_id, request, impact, statement_delivery_key, issued_at, expires_at) VALUES ('c-1','main','t','t@1','r','create','k','2026-10-25T00:00:00Z','2026-10-25T00:10:00Z')",
			).run();
			expect(confirmationResourceUris(db, "c-1")).toEqual([]);
			saveConfirmationRefs(db, "c-1", ["eumenes://image/a"]);
			expect(confirmationResourceUris(db, "c-1")).toEqual([
				"eumenes://image/a",
			]);
		});
	} finally {
		removeDialogueStore(dir);
	}
});
