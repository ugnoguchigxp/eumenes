import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type SqliteStore } from "../../../infrastructure/sqlite";
import {
	type ConversationService,
	migration as conversationMigration,
	createConversationService,
} from "../../conversation";
import {
	ACTIVE_BOOKMARK_MAX,
	ContinuityError,
	type ContinuityErrorCode,
} from "../contracts";
import { migration } from "../repository";
import { type ContinuityService, createContinuityService } from "../service";

const sha256 = (text: string) =>
	createHash("sha256").update(text, "utf8").digest("hex");

interface Fixture {
	dir: string;
	file: string;
	store: SqliteStore;
	conversation: ConversationService;
	service: ContinuityService;
}

function open(dir: string, file = join(dir, "db.sqlite3")): Fixture {
	const store = openStore(file, [conversationMigration, migration]);
	const conversation = createConversationService(store);
	return {
		dir,
		file,
		store,
		conversation,
		service: createContinuityService(store, conversation),
	};
}

async function withFixture(run: (f: Fixture) => Promise<void>) {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-continuity-"));
	let fixture = open(dir);
	try {
		await run(fixture);
	} finally {
		await fixture.store.close().catch(() => {});
		rmSync(dir, { recursive: true, force: true });
	}
}

const seed = (
	f: Fixture,
	id: string,
	text: string,
	role: "user" | "assistant" = "user",
	conversationId = "c1",
) =>
	f.conversation.append({
		id,
		conversationId,
		role,
		text,
		createdAt: "2026-01-01T00:00:00Z",
		runId: null,
	});

async function expectCode(
	promise: Promise<unknown>,
	code: ContinuityErrorCode,
) {
	const error = await promise.then(
		() => null,
		(e: unknown) => e,
	);
	expect(error).toBeInstanceOf(ContinuityError);
	expect((error as ContinuityError).code).toBe(code);
}
function expectCodeSync(run: () => unknown, code: ContinuityErrorCode) {
	try {
		run();
	} catch (error) {
		expect(error).toBeInstanceOf(ContinuityError);
		expect((error as ContinuityError).code).toBe(code);
		return;
	}
	throw new Error("expected_throw");
}

const eventCount = (f: Fixture) =>
	f.store.read(
		(db) =>
			(
				db.query("SELECT COUNT(*) AS n FROM continuity_events").get() as {
					n: number;
				}
			).n,
	);

test("saves three kinds, derives origin, and survives reopen", async () => {
	await withFixture(async (f) => {
		await seed(f, "m1", "ゴールは完成させること");
		await seed(f, "m2", "SQLiteを使う");
		await seed(f, "m3", "認証はどうする？");
		const goal = await f.service.create("c1", {
			requestId: "r1",
			sourceMessageId: "m1",
			kind: "goal",
			text: "  ゴールは完成させること ",
		});
		const decision = await f.service.create("c1", {
			requestId: "r2",
			sourceMessageId: "m2",
			kind: "decision",
			text: "SQLiteのみを使う",
		});
		const question = await f.service.create("c1", {
			requestId: "r3",
			sourceMessageId: "m3",
			kind: "open_question",
			text: "認証はどうする？",
		});
		expect(goal.origin).toBe("user_confirmed");
		expect(goal.text).toBe("ゴールは完成させること");
		expect(goal.revision).toBe(1);
		expect(goal.sourceDigest).toBe(sha256("ゴールは完成させること"));
		expect(decision.origin).toBe("user_edited");
		expect(question.kind).toBe("open_question");
		const before = f.service.list("c1");
		expect(before.stateRevision).toBe(3);
		expect(before.bookmarks.map((b) => b.id)).toEqual([
			goal.id,
			decision.id,
			question.id,
		]);
		const historyBefore = f.service.history("c1", decision.id);
		await f.store.close();

		const reopened = open(f.dir, f.file);
		f = reopened;
		expect(reopened.service.list("c1")).toEqual(before);
		expect(reopened.service.history("c1", decision.id)).toEqual(historyBefore);
		expect(reopened.service.source("c1", goal.id).status).toBe("ok");
		expect(reopened.service.getSnapshot("c1").items).toHaveLength(3);
		await reopened.store.close();
	});
});

test("revise keeps only the latest version active and records history", async () => {
	await withFixture(async (f) => {
		await seed(f, "m1", "元の発言");
		const created = await f.service.create("c1", {
			requestId: "r1",
			sourceMessageId: "m1",
			kind: "goal",
			text: "元の発言",
		});
		expect(created.origin).toBe("user_confirmed");
		const edited = await f.service.revise("c1", created.id, {
			requestId: "r2",
			expectedRevision: 1,
			kind: "decision",
			text: "訂正後",
		});
		expect(edited).toMatchObject({
			revision: 2,
			kind: "decision",
			text: "訂正後",
			origin: "user_edited",
			createdAt: created.createdAt,
		});
		const reverted = await f.service.revise("c1", created.id, {
			requestId: "r3",
			expectedRevision: 2,
			kind: "goal",
			text: "元の発言",
		});
		expect(reverted.origin).toBe("user_confirmed");
		const list = f.service.list("c1");
		expect(list.bookmarks).toHaveLength(1);
		expect(list.bookmarks[0]?.revision).toBe(3);
		const history = f.service.history("c1", created.id);
		expect(
			history.events.map((e) => [e.revision, e.operation, e.text]),
		).toEqual([
			[1, "create", "元の発言"],
			[2, "revise", "訂正後"],
			[3, "revise", "元の発言"],
		]);
		expect(history.nextCursor).toBeNull();
		expect(history.events[0]).not.toHaveProperty("requestDigest");
	});
});

test("deactivate hides from active list but keeps history and the message", async () => {
	await withFixture(async (f) => {
		await seed(f, "m1", "発言1");
		await seed(f, "m2", "発言2");
		const a = await f.service.create("c1", {
			requestId: "r1",
			sourceMessageId: "m1",
			kind: "goal",
			text: "A",
		});
		const b = await f.service.create("c1", {
			requestId: "r2",
			sourceMessageId: "m2",
			kind: "goal",
			text: "B",
		});
		const off = await f.service.deactivate("c1", a.id, {
			requestId: "r3",
			expectedRevision: 1,
		});
		expect(off).toMatchObject({ status: "inactive", revision: 2, text: "A" });
		expect(f.service.list("c1").bookmarks.map((x) => x.id)).toEqual([b.id]);
		const all = f.service.list("c1", { includeInactive: true });
		expect(all.bookmarks.map((x) => [x.id, x.status])).toEqual([
			[a.id, "inactive"],
			[b.id, "active"],
		]);
		expect(all.stateRevision).toBe(3);
		expect(f.service.getSnapshot("c1").items.map((i) => i.bookmark.id)).toEqual(
			[b.id],
		);
		expect(
			f.service.history("c1", a.id).events.map((e) => e.operation),
		).toEqual(["create", "deactivate"]);
		expect(f.conversation.get("c1").messages).toHaveLength(2);
		await expectCode(
			f.service.revise("c1", a.id, {
				requestId: "r4",
				expectedRevision: 2,
				kind: "goal",
				text: "x",
			}),
			"bookmark_inactive",
		);
		await expectCode(
			f.service.deactivate("c1", a.id, {
				requestId: "r5",
				expectedRevision: 2,
			}),
			"bookmark_inactive",
		);
		// Replay of the deactivate still returns the earlier success.
		const replay = await f.service.deactivate("c1", a.id, {
			requestId: "r3",
			expectedRevision: 1,
		});
		expect(replay).toEqual(off);
	});
});

test("history paginates ascending by sequence cursor", async () => {
	await withFixture(async (f) => {
		await seed(f, "m1", "t");
		const b = await f.service.create("c1", {
			requestId: "r0",
			sourceMessageId: "m1",
			kind: "goal",
			text: "t",
		});
		for (let i = 1; i <= 4; i++)
			await f.service.revise("c1", b.id, {
				requestId: `r${i}`,
				expectedRevision: i,
				kind: "goal",
				text: `v${i}`,
			});
		const p1 = f.service.history("c1", b.id, { limit: 2 });
		expect(p1.events.map((e) => e.revision)).toEqual([1, 2]);
		expect(p1.nextCursor).toBe(p1.events[1]?.sequence ?? -1);
		const p2 = f.service.history("c1", b.id, {
			limit: 2,
			after: p1.nextCursor ?? 0,
		});
		expect(p2.events.map((e) => e.revision)).toEqual([3, 4]);
		const p3 = f.service.history("c1", b.id, {
			limit: 2,
			after: p2.nextCursor ?? 0,
		});
		expect(p3.events.map((e) => e.revision)).toEqual([5]);
		expect(p3.nextCursor).toBeNull();
		// limit is clamped to the maximum
		expect(f.service.history("c1", b.id, { limit: 1000 }).events).toHaveLength(
			5,
		);
	});
});

test("source validation rejects missing, other-conversation and assistant messages", async () => {
	await withFixture(async (f) => {
		await seed(f, "m1", "user text");
		await seed(f, "a1", "assistant text", "assistant");
		await seed(f, "o1", "other conversation", "user", "c2");
		const base = { kind: "goal" as const, text: "t" };
		await expectCode(
			f.service.create("c1", {
				...base,
				requestId: "r1",
				sourceMessageId: "nope",
			}),
			"not_found",
		);
		await expectCode(
			f.service.create("c1", {
				...base,
				requestId: "r2",
				sourceMessageId: "o1",
			}),
			"not_found",
		);
		await expectCode(
			f.service.create("c1", {
				...base,
				requestId: "r3",
				sourceMessageId: "a1",
			}),
			"invalid_request",
		);
		expect(eventCount(f)).toBe(0);
		expect(f.service.list("c1").stateRevision).toBe(0);
	});
});

test("snapshot detects changed and missing sources and never mixes them as ok", async () => {
	await withFixture(async (f) => {
		await seed(f, "m1", "one");
		await seed(f, "m2", "two");
		await seed(f, "m3", "three");
		const ids: Record<string, string> = {};
		for (const [i, m] of ["m1", "m2", "m3"].entries()) {
			const b = await f.service.create("c1", {
				requestId: `r${i}`,
				sourceMessageId: m,
				kind: "goal",
				text: m,
			});
			ids[m] = b.id;
		}
		await f.store.write((db) => {
			db.query("UPDATE messages SET text = 'altered' WHERE id = 'm2'").run();
			db.query("PRAGMA foreign_keys=OFF").run();
			db.query("DELETE FROM messages WHERE id = 'm3'").run();
		});
		const snapshot = f.service.getSnapshot("c1");
		expect(
			snapshot.items.map((i) => [i.bookmark.sourceMessageId, i.sourceStatus]),
		).toEqual([
			["m1", "ok"],
			["m2", "changed"],
			["m3", "missing"],
		]);
		const changed = f.service.source("c1", ids.m2 ?? "");
		expect(changed.status).toBe("changed");
		expect(changed.message?.text).toBe("altered");
		const missing = f.service.source("c1", ids.m3 ?? "");
		expect(missing.status).toBe("missing");
		expect(missing.message).toBeNull();
	});
});

test("concurrent updates with the same expectedRevision: exactly one wins", async () => {
	await withFixture(async (f) => {
		await seed(f, "m1", "t");
		const b = await f.service.create("c1", {
			requestId: "r0",
			sourceMessageId: "m1",
			kind: "goal",
			text: "t",
		});
		const results = await Promise.allSettled([
			f.service.revise("c1", b.id, {
				requestId: "ra",
				expectedRevision: 1,
				kind: "goal",
				text: "A",
			}),
			f.service.revise("c1", b.id, {
				requestId: "rb",
				expectedRevision: 1,
				kind: "goal",
				text: "B",
			}),
		]);
		expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
		const rejected = results.find((r) => r.status === "rejected");
		expect((rejected as PromiseRejectedResult).reason).toBeInstanceOf(
			ContinuityError,
		);
		expect(
			((rejected as PromiseRejectedResult).reason as ContinuityError).code,
		).toBe("revision_conflict");
		expect(f.service.list("c1").bookmarks[0]?.revision).toBe(2);
		expect(f.service.history("c1", b.id).events).toHaveLength(2);
	});
});

test("replay returns the original result, even after later revisions", async () => {
	await withFixture(async (f) => {
		await seed(f, "m1", "t");
		const input = {
			requestId: "r1",
			sourceMessageId: "m1",
			kind: "goal" as const,
			text: "first",
		};
		const created = await f.service.create("c1", input);
		expect(await f.service.create("c1", input)).toEqual(created);
		expect(eventCount(f)).toBe(1);

		const revise = {
			requestId: "r2",
			expectedRevision: 1,
			kind: "goal" as const,
			text: "second",
		};
		const revised = await f.service.revise("c1", created.id, revise);
		expect(await f.service.revise("c1", created.id, revise)).toEqual(revised);
		await f.service.revise("c1", created.id, {
			requestId: "r3",
			expectedRevision: 2,
			kind: "goal",
			text: "third",
		});
		// replay of r2 after a later revise: still the r2 result, state not rolled back
		const again = await f.service.revise("c1", created.id, revise);
		expect(again).toEqual(revised);
		expect(again.text).toBe("second");
		expect(f.service.list("c1").bookmarks[0]?.text).toBe("third");
		expect(eventCount(f)).toBe(3);
		// replay of create after revisions returns revision 1
		expect((await f.service.create("c1", input)).revision).toBe(1);
		expect(eventCount(f)).toBe(3);
	});
});

test("same requestId with different content conflicts without writing", async () => {
	await withFixture(async (f) => {
		await seed(f, "m1", "t");
		const created = await f.service.create("c1", {
			requestId: "r1",
			sourceMessageId: "m1",
			kind: "goal",
			text: "first",
		});
		await expectCode(
			f.service.create("c1", {
				requestId: "r1",
				sourceMessageId: "m1",
				kind: "goal",
				text: "different",
			}),
			"request_conflict",
		);
		await expectCode(
			f.service.revise("c1", created.id, {
				requestId: "r1",
				expectedRevision: 1,
				kind: "goal",
				text: "first",
			}),
			"request_conflict",
		);
		await expectCode(
			f.service.deactivate("c1", created.id, {
				requestId: "r1",
				expectedRevision: 1,
			}),
			"request_conflict",
		);
		await f.service.revise("c1", created.id, {
			requestId: "r2",
			expectedRevision: 1,
			kind: "goal",
			text: "x",
		});
		// same requestId + same expectedRevision but different text
		await expectCode(
			f.service.revise("c1", created.id, {
				requestId: "r2",
				expectedRevision: 1,
				kind: "goal",
				text: "y",
			}),
			"request_conflict",
		);
		expect(eventCount(f)).toBe(2);
	});
});

test("failed writes leave no events (limit and bad source) and limit applies to active only", async () => {
	await withFixture(async (f) => {
		await seed(f, "m1", "t");
		await seed(f, "a1", "x", "assistant");
		const ids: string[] = [];
		for (let i = 0; i < ACTIVE_BOOKMARK_MAX; i++) {
			const b = await f.service.create("c1", {
				requestId: `r${i}`,
				sourceMessageId: "m1",
				kind: "goal",
				text: `item ${i}`,
			});
			ids.push(b.id);
		}
		const count = eventCount(f);
		const revision = f.service.list("c1").stateRevision;
		await expectCode(
			f.service.create("c1", {
				requestId: "over",
				sourceMessageId: "m1",
				kind: "goal",
				text: "over",
			}),
			"bookmark_limit_exceeded",
		);
		await expectCode(
			f.service.create("c1", {
				requestId: "bad",
				sourceMessageId: "a1",
				kind: "goal",
				text: "bad",
			}),
			"invalid_request",
		);
		expect(eventCount(f)).toBe(count);
		expect(f.service.list("c1").stateRevision).toBe(revision);
		// failed requestIds are not consumed: after deactivating one, "over" succeeds
		await f.service.deactivate("c1", ids[0] ?? "", {
			requestId: "off",
			expectedRevision: 1,
		});
		const ok = await f.service.create("c1", {
			requestId: "over",
			sourceMessageId: "m1",
			kind: "goal",
			text: "over",
		});
		expect(ok.revision).toBe(1);
		// other conversations have their own limit
		await seed(f, "x1", "t", "user", "c2");
		await f.service.create("c2", {
			requestId: "r0",
			sourceMessageId: "x1",
			kind: "goal",
			text: "ok",
		});
	});
});

test("conversations are isolated and stateRevision is per conversation", async () => {
	await withFixture(async (f) => {
		await seed(f, "m1", "one");
		await seed(f, "x1", "other", "user", "c2");
		const a = await f.service.create("c1", {
			requestId: "r1",
			sourceMessageId: "m1",
			kind: "goal",
			text: "one",
		});
		expect(f.service.list("c1").stateRevision).toBe(1);
		expect(f.service.list("c2")).toEqual({
			conversationId: "c2",
			stateRevision: 0,
			bookmarks: [],
		});
		const other = await f.service.create("c2", {
			requestId: "r1",
			sourceMessageId: "x1",
			kind: "goal",
			text: "other",
		});
		expect(other.id).not.toBe(a.id);
		expect(f.service.list("c1").stateRevision).toBe(1);
		expect(f.service.list("c2").stateRevision).toBe(2);
		// cannot read or update c1's bookmark through c2
		await expectCode(
			f.service.revise("c2", a.id, {
				requestId: "r9",
				expectedRevision: 1,
				kind: "goal",
				text: "hijack",
			}),
			"not_found",
		);
		await expectCode(
			f.service.deactivate("c2", a.id, {
				requestId: "r9",
				expectedRevision: 1,
			}),
			"not_found",
		);
		expectCodeSync(() => f.service.history("c2", a.id), "not_found");
		expectCodeSync(() => f.service.source("c2", a.id), "not_found");
		expect(f.service.list("c1").bookmarks[0]?.text).toBe("one");
		// c1's update does not change c2's stateRevision
		await f.service.revise("c1", a.id, {
			requestId: "r2",
			expectedRevision: 1,
			kind: "goal",
			text: "one!",
		});
		expect(f.service.list("c2").stateRevision).toBe(2);
		expect(f.service.getSnapshot("c1").stateRevision).toBe(3);
	});
});

test("revision mismatch and unknown bookmark", async () => {
	await withFixture(async (f) => {
		await seed(f, "m1", "t");
		const b = await f.service.create("c1", {
			requestId: "r1",
			sourceMessageId: "m1",
			kind: "goal",
			text: "t",
		});
		await expectCode(
			f.service.revise("c1", b.id, {
				requestId: "r2",
				expectedRevision: 2,
				kind: "goal",
				text: "x",
			}),
			"revision_conflict",
		);
		await expectCode(
			f.service.deactivate("c1", b.id, {
				requestId: "r3",
				expectedRevision: 5,
			}),
			"revision_conflict",
		);
		await expectCode(
			f.service.deactivate("c1", "missing", {
				requestId: "r4",
				expectedRevision: 1,
			}),
			"not_found",
		);
		expect(eventCount(f)).toBe(1);
	});
});
