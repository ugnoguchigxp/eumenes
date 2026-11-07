import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConversationService, migrations } from "..";
import { openStore } from "../../../infrastructure/sqlite";
import { syntheticImages } from "./image.fixture";

// SQL applied on 2026-11-07, independently pinned so an edit cannot hide an upgrade failure.
const deployedSql = `CREATE TABLE conversation_image_answers (
 message_id TEXT NOT NULL REFERENCES messages(id), ordinal INTEGER NOT NULL,
 source_message_id TEXT NOT NULL REFERENCES messages(id), attachment_id TEXT NOT NULL REFERENCES conversation_attachments(id),
 answer_revision TEXT NOT NULL, source_revision TEXT NOT NULL,
 request_id TEXT NOT NULL, attempt_id TEXT NOT NULL, adopted_at TEXT NOT NULL,
 PRIMARY KEY(message_id, ordinal)
);`;
const deployedId = "conversation/0017-image-answers";
const upgradeId = "conversation/0018-image-answer-sequences";
const deployedChecksum =
	"9013b71e14303ae076d50890dac9a5cbf486203934d2d0195a34bc34b0a85a50";

test("the deployed image-answer migration keeps its recorded checksum", () => {
	const hash = (sql: string) => createHash("sha256").update(sql).digest("hex");
	expect(hash(deployedSql)).toBe(deployedChecksum);
	expect(hash(migrations.find((m) => m.id === deployedId)!.sql)).toBe(
		deployedChecksum,
	);
});

test("deployed image-answer evidence upgrades without rewriting history or reviving corrected sources", async () => {
	const dir = mkdtempSync(join(tmpdir(), "image-answer-upgrade-"));
	const path = join(dir, "db.sqlite3");
	const oldMigrations = migrations
		.filter((m) => m.id !== upgradeId)
		.map((m) => (m.id === deployedId ? { ...m, sql: deployedSql } : m));
	let store = openStore(path, oldMigrations);
	let c = createConversationService(store, { requireOutbox: true });
	try {
		const at = "2026-11-07T03:00:00.000Z";
		const image = await c.uploadAttachment(
			"main",
			crypto.randomUUID(),
			(await syntheticImages())[1]!,
		);
		for (const [id, role] of [
			["input", "user"],
			["stale-input", "user"],
			["answer", "assistant"],
			["stale-answer", "assistant"],
			["corrected-answer", "assistant"],
		] as const)
			await c.append({
				id,
				role,
				text: "retained",
				conversationId: "main",
				runId: "vision",
				createdAt: at,
				...(role === "user" ? { attachments: [image] } : {}),
			});
		await store.write((db) => {
			for (const [answer, source] of [
				["answer", "input"],
				["stale-answer", "stale-input"],
				["corrected-answer", "input"],
			])
				db.query(
					`INSERT INTO conversation_image_answers
SELECT ?, 0, ?, ?, a.revision, s.revision, 'request', 'attempt', ?
FROM conversation_outbox a, conversation_outbox s WHERE a.source_id=? AND s.source_id=?`,
				).run(answer!, source!, image.id, at, answer!, source!);
		});
		await c.correct({ messageId: "stale-input", text: "changed" });
		await c.correct({ messageId: "stale-input", text: "retained" });
		await c.correct({ messageId: "corrected-answer", text: "corrected" });
		const history = store.read((db) =>
			db.query("SELECT * FROM schema_migrations_v2 ORDER BY id").all(),
		);
		const messages = c.get("main");
		await store.close();
		store = openStore(path, migrations);
		c = createConversationService(store, { requireOutbox: true });
		expect(c.get("main")).toEqual(messages);
		expect(
			store.read((db) =>
				db
					.query("SELECT * FROM schema_migrations_v2 WHERE id<>? ORDER BY id")
					.all(upgradeId),
			),
		).toEqual(history);
		expect(
			store.read((db) => c.imageReferencesInTransaction(db, "answer")),
		).toEqual([
			{
				messageId: "input",
				attachmentIds: [image.id],
				answerEvidence: {
					requestId: "request",
					attemptId: "attempt",
					adoptedAt: at,
				},
			},
		]);
		for (const id of ["stale-answer", "corrected-answer"])
			expect(
				store.read((db) => c.imageReferencesInTransaction(db, id)),
			).toEqual([]);
		expect(
			store.read((db) =>
				db.query("SELECT COUNT(*) AS n FROM conversation_image_answers").get(),
			),
		).toEqual({ n: 3 });
		await store.close();
		store = openStore(path, migrations);
		expect(
			store.read((db) => db.query("PRAGMA foreign_key_check").all()),
		).toEqual([]);
	} finally {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
