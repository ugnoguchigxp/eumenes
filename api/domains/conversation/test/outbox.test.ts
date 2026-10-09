import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
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
} from "..";

const migrations = [
	migration,
	avatarMotionMigration,
	answerDeliveryMigration,
	outboxMigration,
	retractionMigration,
];
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
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

async function withStore<T>(
	run: (
		store: ReturnType<typeof openStore>,
		service: ReturnType<typeof createConversationService>,
	) => Promise<T>,
	options?: Parameters<typeof createConversationService>[1],
) {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-outbox-"));
	const store = openStore(join(dir, "test.sqlite3"), migrations);
	try {
		return await run(store, createConversationService(store, options));
	} finally {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
}
const events = (
	service: ReturnType<typeof createConversationService>,
	store: ReturnType<typeof openStore>,
) => store.read((db) => service.changesInTransaction(db, 0, 100));

test("append records an added event with memory-compatible revision, no text", async () => {
	await withStore(async (store, service) => {
		await service.append(message("m1", "こんにちは"));
		const [event, ...rest] = events(service, store);
		expect(rest).toEqual([]);
		expect(event).toMatchObject({
			kind: "added",
			namespace: "conversation",
			sourceKind: "message",
			sourceId: "m1",
			representation: "text",
			revision: `sha256:${sha("こんにちは")}`,
			digest: sha("こんにちは"),
			principal: CONVERSATION_DEFAULT_PRINCIPAL,
			scopeKey: CONVERSATION_DEFAULT_SCOPE,
			speaker: "user",
		});
		expect(JSON.stringify(event)).not.toContain("こんにちは");
	});
});

test("principal and scope are injectable", async () => {
	await withStore(
		async (store, service) => {
			await service.append(message("m1", "a"));
			expect(events(service, store)[0]).toMatchObject({
				principal: "p2",
				scopeKey: "s2",
			});
		},
		{ principal: "p2", scopeKey: "s2" },
	);
});

test("message save and outbox event roll back together on a mid-save exception", async () => {
	await withStore(async (store, service) => {
		await expect(
			store.write((db) => {
				service.appendInTransaction(db, message("m1", "first"));
				throw new Error("injected_after_save");
			}),
		).rejects.toThrow("injected_after_save");
		expect(service.get("c1").messages).toEqual([]);
		expect(events(service, store)).toEqual([]);
		// The outbox insert itself failing also takes the message with it.
		await store.write((db) =>
			db.exec(
				"CREATE TRIGGER fail_outbox BEFORE INSERT ON conversation_outbox BEGIN SELECT RAISE(ABORT, 'injected_outbox'); END",
			),
		);
		await expect(service.append(message("m2", "second"))).rejects.toThrow(
			"injected_outbox",
		);
		expect(service.get("c1").messages).toEqual([]);
		expect(service.get("c1").revision).toBe(0);
		// Correction and retraction roll back the same way.
		await store.write((db) => db.exec("DROP TRIGGER fail_outbox"));
		await service.append(message("m3", "keep"));
		await store.write((db) =>
			db.exec(
				"CREATE TRIGGER fail_outbox BEFORE INSERT ON conversation_outbox BEGIN SELECT RAISE(ABORT, 'injected_outbox'); END",
			),
		);
		await expect(
			service.correct({ messageId: "m3", text: "changed" }),
		).rejects.toThrow("injected_outbox");
		await expect(service.retract({ messageId: "m3" })).rejects.toThrow(
			"injected_outbox",
		);
		expect(service.get("c1").messages.map((m) => m.text)).toEqual(["keep"]);
	});
});

test("correction changes the revision, emits corrected, and replay is idempotent", async () => {
	await withStore(async (store, service) => {
		await service.append(message("m1", "before", "assistant"));
		const result = await service.correct({
			messageId: "m1",
			text: "after",
			at: "2026-01-02T00:00:00Z",
		});
		expect(result).toMatchObject({
			status: "applied",
			kind: "corrected",
			revision: `sha256:${sha("after")}`,
			conversationRevision: 2,
		});
		expect(service.get("c1").messages[0]?.text).toBe("after");
		const replay = await service.correct({ messageId: "m1", text: "after" });
		expect(replay).toEqual({ status: "unchanged" });
		const all = events(service, store);
		expect(all.map((e) => e.kind)).toEqual(["added", "corrected"]);
		expect(all[1]).toMatchObject({
			speaker: "assistant",
			revision: `sha256:${sha("after")}`,
			occurredAt: "2026-01-02T00:00:00Z",
		});
		expect(all[0]?.revision).not.toBe(all[1]?.revision);
		expect(service.get("c1").revision).toBe(2);
		await expect(
			service.correct({ messageId: "m1", text: "" }),
		).rejects.toThrow("empty_correction");
		expect(await service.correct({ messageId: "nope", text: "x" })).toEqual({
			status: "not_found",
		});
		expect(events(service, store)).toHaveLength(2);
	});
});

test("retraction removes the text, emits retracted once, and blocks correction/re-add", async () => {
	await withStore(async (store, service) => {
		await service.append(message("m1", "secret"));
		const result = await service.retract({ messageId: "m1" });
		expect(result).toMatchObject({ status: "applied", kind: "retracted" });
		expect(service.get("c1").messages).toEqual([]);
		expect(
			store.read((db) => service.messageInTransaction(db, "m1")),
		).toBeNull();
		expect(
			store.read((db) => service.sourceInTransaction(db, "m1")),
		).toMatchObject({
			state: "retracted",
		});
		expect(await service.retract({ messageId: "m1" })).toEqual({
			status: "unchanged",
		});
		expect(await service.correct({ messageId: "m1", text: "x" })).toEqual({
			status: "retracted",
		});
		await expect(service.append(message("m1", "again"))).rejects.toThrow(
			"message_retracted",
		);
		const all = events(service, store);
		expect(all.map((e) => e.kind)).toEqual(["added", "retracted"]);
		expect(all[1]).toMatchObject({ revision: "retracted", digest: "" });
		expect(JSON.stringify(all)).not.toContain("secret");
		expect(await service.retract({ messageId: "never" })).toEqual({
			status: "not_found",
		});
	});
});

test("seq is increasing with gaps allowed and drafts have no path to the outbox", async () => {
	await withStore(async (store, service) => {
		await service.append(message("m1", "a"));
		await service.append(message("m2", "b"));
		await service.append(message("m3", "c"));
		// Simulate compaction: remove the middle event to leave a gap.
		await store.write((db) =>
			db.exec("DELETE FROM conversation_outbox WHERE source_id = 'm2'"),
		);
		const seqs = events(service, store).map((e) => e.seq);
		expect(seqs.length).toBe(2);
		expect(seqs[1]! - seqs[0]!).toBe(2);
		expect(
			store.read((db) => service.changesInTransaction(db, seqs[0]!, 10)),
		).toHaveLength(1);
		// Only confirmed appends/corrections/retractions write events: a failed
		// or no-op operation (draft-like input that never reaches append) adds none.
		const before = events(service, store).length;
		await service.correct({ messageId: "draft-never-saved", text: "partial" });
		await service.retract({ messageId: "draft-never-saved" });
		expect(events(service, store)).toHaveLength(before);
	});
});

test("a database without the outbox migration keeps working unless required", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-outbox-legacy-"));
	const store = openStore(join(dir, "test.sqlite3"), migrations.slice(0, 3));
	try {
		const lenient = createConversationService(store);
		await lenient.append(message("m1", "legacy"));
		expect(store.read((db) => lenient.outboxReadyInTransaction(db))).toBe(
			false,
		);
		expect(lenient.get("c1").messages).toHaveLength(1);
		await expect(
			lenient.correct({ messageId: "m1", text: "x" }),
		).rejects.toThrow("conversation_outbox_missing");
		const strict = createConversationService(store, { requireOutbox: true });
		await expect(strict.append(message("m2", "x"))).rejects.toThrow(
			"conversation_outbox_missing",
		);
	} finally {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("correction scrubs the digest of superseded revisions but keeps seq order and the newest digest", async () => {
	await withStore(async (store, service) => {
		await service.append(message("m1", "v1-text"));
		await service.append(message("m2", "other"));
		await service.correct({ messageId: "m1", text: "v2-text" });
		await service.correct({ messageId: "m1", text: "v3-text" });
		const dump = JSON.stringify(
			store.read((db) => db.query("SELECT * FROM conversation_outbox").all()),
		);
		expect(dump).not.toContain(sha("v1-text"));
		expect(dump).not.toContain(sha("v2-text"));
		expect(dump).toContain(sha("v3-text"));
		expect(dump).toContain(sha("other"));
		const all = events(service, store);
		const seqs = all.map((e) => e.seq);
		expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
		expect(all.map((e) => `${e.sourceId}:${e.kind}`)).toEqual([
			"m1:added",
			"m2:added",
			"m1:corrected",
			"m1:corrected",
		]);
		// A cursor in the middle still resumes exactly after it.
		expect(
			store
				.read((db) => service.changesInTransaction(db, seqs[1]!, 10))
				.map((e) => e.seq),
		).toEqual([seqs[2]!, seqs[3]!]);
		expect(all[3]).toMatchObject({ digest: sha("v3-text") });
		// Retraction scrubs everything of that source and keeps the other source.
		await service.retract({ messageId: "m1" });
		const after = JSON.stringify(
			store.read((db) => db.query("SELECT * FROM conversation_outbox").all()),
		);
		expect(after).not.toContain(sha("v3-text"));
		expect(after).toContain(sha("other"));
		expect(events(service, store).map((e) => e.seq)).toEqual([
			...seqs,
			expect.any(Number),
		]);
	});
});

test("without the retraction column reads and corrections work and retraction fails clearly", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-outbox-noretract-"));
	const store = openStore(join(dir, "test.sqlite3"), migrations.slice(0, 4));
	try {
		const service = createConversationService(store, { requireOutbox: true });
		expect(store.read((db) => service.retractionReadyInTransaction(db))).toBe(
			false,
		);
		await service.append(message("m1", "keep"));
		expect(service.get("c1").messages).toHaveLength(1);
		expect(
			await service.correct({ messageId: "m1", text: "kept" }),
		).toMatchObject({ status: "applied" });
		await expect(service.retract({ messageId: "m1" })).rejects.toThrow(
			"conversation_retraction_missing",
		);
		expect(service.get("c1").messages[0]?.text).toBe("kept");
	} finally {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
