import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import { createConversationService, migrations } from "..";
import { syntheticImages } from "./image.fixture";

test("image-answer receipts persist separately from content correctness and are invalidated by source/answer changes", async () => {
	const dir = mkdtempSync(join(tmpdir(), "image-answer-evidence-"));
	const path = join(dir, "db");
	let store = openStore(path, migrations);
	let c = createConversationService(store, { requireOutbox: true });
	try {
		const at = new Date().toISOString();
		const image = await c.uploadAttachment(
			"main",
			crypto.randomUUID(),
			(await syntheticImages())[1]!,
		);
		await c.append({
			id: "input",
			role: "user",
			text: "",
			conversationId: "main",
			runId: "vision",
			createdAt: at,
			attachments: [image],
		});
		for (const id of ["answer", "legacy", "wrong-source", "source-change"])
			await c.append({
				id,
				role: "assistant",
				text: "ハムスターのオフィスです。",
				conversationId: "main",
				runId: "vision",
				createdAt: at,
			});
		const trace = {
			requestId: "request",
			attemptId: "attempt",
			inputs: [{ messageId: "input", attachmentIds: [image.id] }],
		};
		const refs = (id: string) =>
			store.read((db) => c.imageReferencesInTransaction(db, id));
		expect(refs("legacy")[0]!.answerEvidence).toBeUndefined();
		await store.write((db) =>
			c.recordImageAnswerInTransaction(db, "answer", trace, at),
		);
		await store.write((db) =>
			c.recordImageAnswerInTransaction(db, "source-change", trace, at),
		);
		expect(refs("answer")[0]!.answerEvidence).toEqual({
			requestId: "request",
			attemptId: "attempt",
			adoptedAt: at,
		});
		await expect(
			store.write((db) =>
				c.recordImageAnswerInTransaction(
					db,
					"wrong-source",
					{
						...trace,
						inputs: [
							{ messageId: "input", attachmentIds: [crypto.randomUUID()] },
						],
					},
					at,
				),
			),
		).rejects.toThrow("image_answer_source_invalid");
		expect(refs("wrong-source")[0]!.answerEvidence).toBeUndefined();
		await c.append({
			id: "private",
			role: "assistant",
			text: "別会話",
			conversationId: "private",
			runId: "vision",
			createdAt: at,
		});
		await expect(
			store.write((db) =>
				c.recordImageAnswerInTransaction(db, "private", trace, at),
			),
		).rejects.toThrow("image_answer_source_invalid");
		expect(refs("private")).toEqual([]);
		await store.close();
		store = openStore(path, migrations);
		c = createConversationService(store, { requireOutbox: true });
		const saved = c
			.searchHistory("main", { query: "ハムスター" })
			.candidates.find((m) => m.messageId === "answer")!;
		expect(saved.imageReferences?.[0]!.answerEvidence?.attemptId).toBe(
			"attempt",
		);
		expect(JSON.stringify(saved)).not.toMatch(/base64|data:image|bytes/);
		await store.write((db) =>
			c.moveToRunInTransaction(db, "input", "another-run"),
		);
		expect(refs("answer")[0]!.answerEvidence?.attemptId).toBe("attempt");
		await c.correct({
			messageId: "answer",
			text: "読み取り結果を訂正した回答",
		});
		expect(refs("answer")).toEqual([]);
		await c.correct({ messageId: "input", text: "入力を訂正" });
		expect(refs("source-change")).toEqual([]);
	} finally {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
