import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccessContext, SourceRef } from "eumenes-memory";
import { openStore } from "../../../infrastructure/sqlite";
import {
	CONVERSATION_DEFAULT_PRINCIPAL,
	CONVERSATION_DEFAULT_SCOPE,
	answerDeliveryMigration,
	avatarMotionMigration,
	createConversationService,
	migration,
	outboxMigration,
	retractionMigration,
} from "../../conversation";
import { PRINCIPAL, PROFILE_SCOPE } from "../../memory/contracts";
import {
	SourceAccessError,
	SourceCursorError,
	createConversationSourceAdapter,
	deletionsFirst,
} from "..";

const PURPOSE = "world.test";
const access = (over: Partial<AccessContext> = {}): AccessContext => ({
	principal: CONVERSATION_DEFAULT_PRINCIPAL,
	scopeKeys: [CONVERSATION_DEFAULT_SCOPE],
	purpose: PURPOSE,
	policyRevision: "1",
	...over,
});
const key = (id: string) => ({
	namespace: "conversation",
	kind: "message",
	id,
	representation: "text",
});
const message = (
	id: string,
	text: string,
	role: "user" | "assistant" = "user",
) => ({
	id,
	conversationId: "c1",
	role,
	text,
	createdAt: "2026-01-01T00:00:00Z",
	runId: null,
});

async function setup<T>(
	run: (ctx: {
		store: ReturnType<typeof openStore>;
		conversation: ReturnType<typeof createConversationService>;
		adapter: ReturnType<typeof createConversationSourceAdapter>;
	}) => Promise<T>,
) {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-world-source-"));
	const store = openStore(join(dir, "test.sqlite3"), [
		migration,
		avatarMotionMigration,
		answerDeliveryMigration,
		outboxMigration,
		retractionMigration,
	]);
	const conversation = createConversationService(store, {
		requireOutbox: true,
	});
	const adapter = createConversationSourceAdapter(conversation, {
		allowedPurposes: [PURPOSE],
	});
	try {
		return await run({ store, conversation, adapter });
	} finally {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
}
const refOf = (
	current: { revision: string; digest: string },
	id: string,
	range?: { startByte: number; endByte: number },
): SourceRef => ({
	...key(id),
	revision: current.revision,
	digest: current.digest,
	...(range ? { range } : {}),
});

test("conversation default principal/scope equal memory's constants", () => {
	expect(CONVERSATION_DEFAULT_PRINCIPAL).toBe(PRINCIPAL);
	expect(CONVERSATION_DEFAULT_SCOPE).toBe(PROFILE_SCOPE);
});

test("resolveCurrent returns revision/digest/scope/speaker/confirmed and follows correction", async () => {
	await setup(async ({ store, conversation, adapter }) => {
		await conversation.append(message("m1", "hello", "assistant"));
		const first = store.read((db) =>
			adapter.resolveCurrent(db, access(), key("m1")),
		);
		expect(first).toMatchObject({
			status: "available",
			scopeKey: PROFILE_SCOPE,
			principal: PRINCIPAL,
			speaker: "assistant",
			confirmed: true,
		});
		await conversation.correct({ messageId: "m1", text: "hello!" });
		const second = store.read((db) =>
			adapter.resolveCurrent(db, access(), key("m1")),
		);
		expect(second).toMatchObject({ status: "available" });
		expect(
			(second as { revision: string }).revision !==
				(first as { revision: string }).revision,
		).toBe(true);
	});
});

test("missing and retracted sources return an explicit missing state", async () => {
	await setup(async ({ store, conversation, adapter }) => {
		await conversation.append(message("m1", "bye"));
		await conversation.retract({ messageId: "m1" });
		const read = (id: string) =>
			store.read((db) => adapter.resolveCurrent(db, access(), key(id)));
		expect(read("m1")).toMatchObject({
			status: "missing",
			reason: "retracted",
		});
		expect(read("nope")).toMatchObject({
			status: "missing",
			reason: "not_found",
		});
		const content = store.read((db) =>
			adapter.readAuthorizedContent(db, access(), {
				...key("m1"),
				revision: "sha256:x",
				digest: "x",
			}),
		);
		expect(content).toMatchObject({ status: "missing", reason: "retracted" });
		expect(JSON.stringify(content)).not.toContain("bye");
		// Other namespaces/representations are simply not this adapter's sources.
		expect(
			store.read((db) =>
				adapter.resolveCurrent(db, access(), {
					...key("m1"),
					namespace: "records",
				}),
			),
		).toMatchObject({ status: "missing", reason: "not_found" });
	});
});

test("a stale revision/digest reads as changed without a body", async () => {
	await setup(async ({ store, conversation, adapter }) => {
		await conversation.append(message("m1", "v1"));
		const old = store.read((db) =>
			adapter.resolveCurrent(db, access(), key("m1")),
		) as { revision: string; digest: string };
		await conversation.correct({ messageId: "m1", text: "v2" });
		const content = store.read((db) =>
			adapter.readAuthorizedContent(db, access(), refOf(old, "m1")),
		);
		expect(content.status).toBe("changed");
		expect(JSON.stringify(content)).not.toContain('v2"');
		const current = store.read((db) =>
			adapter.resolveCurrent(db, access(), key("m1")),
		) as { revision: string; digest: string };
		expect(
			store.read((db) =>
				adapter.readAuthorizedContent(db, access(), refOf(current, "m1")),
			),
		).toMatchObject({ status: "ok", text: "v2" });
	});
});

test("another principal or scope gets no body, no count and no existence hint", async () => {
	await setup(async ({ store, conversation, adapter }) => {
		await conversation.append(message("m1", "private body"));
		await conversation.append(message("m2", "more"));
		const current = store.read((db) =>
			adapter.resolveCurrent(db, access(), key("m1")),
		) as { revision: string; digest: string };
		const denied = [
			access({ principal: "someone:else" }),
			access({ scopeKeys: ["profile:other"] }),
			access({ scopeKeys: [] }),
		];
		const baseline = store.read((db) =>
			adapter.resolveCurrent(db, access(), key("never-existed")),
		);
		for (const ctx of denied) {
			const resolved = store.read((db) =>
				adapter.resolveCurrent(db, ctx, key("m1")),
			);
			// Indistinguishable from a source that never existed (apart from id).
			expect(resolved).toMatchObject({
				status: "missing",
				reason: "not_found",
			});
			expect({ ...resolved, source: undefined }).toEqual({
				...baseline,
				source: undefined,
			});
			const content = store.read((db) =>
				adapter.readAuthorizedContent(db, ctx, refOf(current, "m1")),
			);
			expect(content).toMatchObject({ status: "missing", reason: "not_found" });
			expect(JSON.stringify(content)).not.toContain("private body");
			const stale = store.read((db) =>
				adapter.readAuthorizedContent(
					db,
					ctx,
					refOf({ revision: "sha256:old", digest: "old" }, "m1"),
				),
			);
			expect(stale.status).toBe("missing");
			const page = store.read((db) =>
				adapter.listChanges(db, ctx, { cursor: null, limit: 10 }),
			);
			expect(page).toMatchObject({ changes: [], hasMore: false });
			// Opaque: nothing of the raw outbox sequence is readable from it.
			expect(page.nextCursor).toMatch(/^c1\.[0-9a-f]{14}\.[0-9a-f]{12}$/);
			expect(page.nextCursor).not.toContain("conv:");
		}
	});
});

test("request-level purpose and access shape are enforced before any source is touched", async () => {
	await setup(async ({ store, adapter }) => {
		expect(() =>
			store.read((db) =>
				adapter.resolveCurrent(db, access({ purpose: "other" }), key("m1")),
			),
		).toThrow(SourceAccessError);
		expect(() =>
			store.read((db) =>
				adapter.listChanges(db, access({ purpose: "" }), {
					cursor: null,
					limit: 1,
				}),
			),
		).toThrow(SourceAccessError);
	});
});

test("Unicode quote ranges use UTF-8 byte offsets on code point boundaries", async () => {
	await setup(async ({ store, conversation, adapter }) => {
		const text = "A😀日本語"; // 1 + 4 + 3*3 bytes
		await conversation.append(message("m1", text));
		const current = store.read((db) =>
			adapter.resolveCurrent(db, access(), key("m1")),
		) as { revision: string; digest: string };
		const read = (range: { startByte: number; endByte: number }) =>
			store.read((db) =>
				adapter.readAuthorizedContent(
					db,
					access(),
					refOf(current, "m1", range),
				),
			);
		expect(read({ startByte: 1, endByte: 5 })).toMatchObject({
			status: "ok",
			text: "😀",
		});
		expect(read({ startByte: 5, endByte: 11 })).toMatchObject({
			status: "ok",
			text: "日本",
		});
		const whole = read({ startByte: 0, endByte: 14 });
		expect(whole).toMatchObject({ status: "ok", text });
		expect((whole as { quoteDigest?: string }).quoteDigest).toMatch(
			/^[0-9a-f]{64}$/,
		);
		// Inside the emoji and inside a Japanese character.
		expect(read({ startByte: 2, endByte: 5 })).toMatchObject({
			status: "invalid_range",
			reasonCode: "SOURCE_RANGE_NOT_CHAR_BOUNDARY",
		});
		expect(read({ startByte: 5, endByte: 7 })).toMatchObject({
			status: "invalid_range",
			reasonCode: "SOURCE_RANGE_NOT_CHAR_BOUNDARY",
		});
		expect(read({ startByte: 0, endByte: 15 })).toMatchObject({
			status: "invalid_range",
			reasonCode: "SOURCE_RANGE_OUT_OF_BOUNDS",
		});
		for (const bad of [
			{ startByte: -1, endByte: 3 },
			{ startByte: 3, endByte: 3 },
			{ startByte: 4, endByte: 2 },
			{ startByte: 0.5, endByte: 3 },
		])
			expect(read(bad)).toMatchObject({
				status: "invalid_range",
				reasonCode: "SOURCE_RANGE_OUT_OF_BOUNDS",
			});
	});
});

test("listChanges pages by opaque cursor, tolerates gaps, and includes deletions", async () => {
	await setup(async ({ store, conversation, adapter }) => {
		for (const id of ["m1", "m2", "m3", "m4"])
			await conversation.append(message(id, `text ${id}`));
		await conversation.correct({ messageId: "m1", text: "fixed" });
		await conversation.retract({ messageId: "m2" });
		// Gap: remove m3's event.
		await store.write((db) =>
			db.exec("DELETE FROM conversation_outbox WHERE source_id = 'm3'"),
		);
		const seen: string[] = [];
		let cursor: string | null = null;
		for (;;) {
			const page: ReturnType<typeof adapter.listChanges> = store.read((db) =>
				adapter.listChanges(db, access(), { cursor, limit: 2 }),
			);
			seen.push(...page.changes.map((c) => `${c.kind}:${c.source.id}`));
			cursor = page.nextCursor;
			if (!page.hasMore) break;
		}
		expect(seen).toEqual([
			"added:m1",
			"added:m2",
			"added:m4",
			"corrected:m1",
			"retracted:m2",
		]);
		// Resuming at the end yields nothing and keeps the cursor.
		const tail = store.read((db) =>
			adapter.listChanges(db, access(), { cursor, limit: 5 }),
		);
		expect(tail).toEqual({
			changes: [],
			nextCursor: cursor ?? "",
			hasMore: false,
		});
		expect(() =>
			store.read((db) =>
				adapter.listChanges(db, access(), { cursor: "bogus", limit: 1 }),
			),
		).toThrow(SourceCursorError);
		expect(() =>
			store.read((db) =>
				adapter.listChanges(db, access(), { cursor: null, limit: 0 }),
			),
		).toThrow(RangeError);
	});
});

test("a deletion can be applied before earlier events of the same source", async () => {
	await setup(async ({ store, conversation, adapter }) => {
		await conversation.append(message("m1", "one"));
		await conversation.append(message("m2", "two"));
		await conversation.correct({ messageId: "m1", text: "uno" });
		await conversation.retract({ messageId: "m1" });
		const page = store.read((db) =>
			adapter.listChanges(db, access(), { cursor: null, limit: 10 }),
		);
		const ordered = deletionsFirst(page.changes);
		expect(ordered.map((c) => `${c.kind}:${c.source.id}`)).toEqual([
			"retracted:m1",
			"added:m2",
		]);
		// Whatever order the consumer sees the events, the source ends up missing.
		expect(
			store.read((db) => adapter.resolveCurrent(db, access(), key("m1"))),
		).toMatchObject({ status: "missing", reason: "retracted" });
	});
});

test("draft or unconfirmed text is never a source", async () => {
	await setup(async ({ store, conversation, adapter }) => {
		// A partial ASR result is simply never appended: no source, no event.
		expect(
			store.read((db) => adapter.resolveCurrent(db, access(), key("draft-1"))),
		).toMatchObject({ status: "missing", reason: "not_found" });
		expect(
			store.read((db) =>
				adapter.listChanges(db, access(), { cursor: null, limit: 5 }),
			).changes,
		).toEqual([]);
		await conversation.correct({ messageId: "draft-1", text: "partial" });
		expect(
			store.read((db) => conversation.changesInTransaction(db, 0, 5)),
		).toEqual([]);
	});
});

test("cursor is opaque, authenticated and advances past an out-of-scope tail", async () => {
	await setup(async ({ store, conversation }) => {
		const calls: number[] = [];
		const spy = {
			...conversation,
			changesInTransaction: (
				db: Parameters<typeof conversation.changesInTransaction>[0],
				after: number,
				limit: number,
			) => {
				calls.push(after);
				return conversation.changesInTransaction(db, after, limit);
			},
		};
		const adapter = createConversationSourceAdapter(spy, {
			allowedPurposes: [PURPOSE],
			cursorSecret: "secret-a",
		});
		for (const id of ["m1", "m2", "m3"])
			await conversation.append(message(id, `t ${id}`));
		const stranger = access({ principal: "someone:else" });
		const first = store.read((db) =>
			adapter.listChanges(db, stranger, { cursor: null, limit: 5 }),
		);
		expect(first).toMatchObject({ changes: [], hasMore: false });
		// The next poll starts after the scanned tail instead of rescanning it.
		calls.length = 0;
		const second = store.read((db) =>
			adapter.listChanges(db, stranger, { cursor: first.nextCursor, limit: 5 }),
		);
		expect(second).toMatchObject({ changes: [], hasMore: false });
		expect(second.nextCursor).toBe(first.nextCursor);
		expect(calls[0]).toBe(3);
		// A new in-scope event after that tail is still seen by the owner from null.
		await conversation.append(message("m4", "t m4"));
		const owner = store.read((db) =>
			adapter.listChanges(db, access(), { cursor: first.nextCursor, limit: 5 }),
		);
		expect(owner.changes.map((c) => c.source.id)).toEqual(["m4"]);
		// The page cursors never equal the raw sequence and are never going back.
		const all = store.read((db) =>
			adapter.listChanges(db, access(), { cursor: null, limit: 5 }),
		);
		const cursors = all.changes.map((c) => c.cursor);
		expect(new Set(cursors).size).toBe(4);
		for (const [i, cursor] of cursors.entries()) {
			expect(cursor).not.toMatch(new RegExp(`[:.]0*${i + 1}(\\.|$)`));
			const resumed = store.read((db) =>
				adapter.listChanges(db, access(), { cursor, limit: 5 }),
			);
			expect(resumed.changes).toHaveLength(3 - i);
		}
		// Paging with hasMore resumes exactly where the page stopped.
		const paged = store.read((db) =>
			adapter.listChanges(db, access(), { cursor: null, limit: 2 }),
		);
		expect(paged.hasMore).toBe(true);
		expect(
			store
				.read((db) =>
					adapter.listChanges(db, access(), {
						cursor: paged.nextCursor,
						limit: 5,
					}),
				)
				.changes.map((c) => c.source.id),
		).toEqual(["m3", "m4"]);
		// Tampered, wrong-version and other-secret cursors are rejected.
		const other = createConversationSourceAdapter(spy, {
			allowedPurposes: [PURPOSE],
			cursorSecret: "secret-b",
		});
		const forged = `${first.nextCursor.slice(0, -1)}${first.nextCursor.endsWith("0") ? "1" : "0"}`;
		for (const bad of [forged, "conv:2", "c2.00000000000000.000000000000"])
			expect(() =>
				store.read((db) =>
					adapter.listChanges(db, access(), { cursor: bad, limit: 1 }),
				),
			).toThrow(SourceCursorError);
		expect(() =>
			store.read((db) =>
				other.listChanges(db, access(), { cursor: first.nextCursor, limit: 1 }),
			),
		).toThrow(SourceCursorError);
	});
});
