import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import { createConversationService, migrations } from "..";
import { syntheticImages } from "./image.fixture";

test("image analysis stays linked in text history across restart, corrections and retraction", async () => {
	const dir = mkdtempSync(join(tmpdir(), "image-context-"));
	const path = join(dir, "db");
	let store = openStore(path, migrations);
	let c = createConversationService(store, { requireOutbox: true });
	try {
		const image = await c.uploadAttachment(
			"main",
			crypto.randomUUID(),
			(await syntheticImages())[1]!,
		);
		const append = (
			id: string,
			role: "user" | "assistant",
			text: string,
			runId: string,
			conversationId = "main",
		) =>
			c.append({
				id,
				role,
				text,
				runId,
				conversationId,
				createdAt: new Date().toISOString(),
				...(id === "image-input" ? { attachments: [image] } : {}),
			});
		await append("image-input", "user", "図形と文字を教えて", "vision");
		await append(
			"analysis",
			"assistant",
			"赤い円3個、青い四角2個、緑の三角1個。文字はR7K4です。",
			"vision",
		);
		await append("followup", "user", "四角の色は？", "followup");
		await append(
			"followup-answer",
			"assistant",
			"先ほどの読み取りでは青色です。",
			"followup",
		);
		await append("correction", "user", "四角は紫です", "correction");
		await append("other", "assistant", "別会話", "vision", "private");
		const references = [
			{ messageId: "image-input", attachmentIds: [image.id] },
		];
		expect(
			store.read((db) => c.imageReferencesInTransaction(db, "analysis")),
		).toEqual(references);
		expect(
			store.read((db) => c.imageReferencesInTransaction(db, "other")),
		).toEqual([]);
		await store.close();
		store = openStore(path, migrations);
		c = createConversationService(store, { requireOutbox: true });
		const search = c.searchHistory("main", { query: "R7K4" });
		expect(search.candidates[0]!.imageReferences).toEqual(references);
		const read = c.readHistory("main", {
			messageRef: search.candidates[0]!.messageRef,
			before: 1,
			after: 3,
		});
		expect(read.messages.map((m) => m.messageId)).toEqual([
			"image-input",
			"analysis",
			"followup",
			"followup-answer",
			"correction",
		]);
		expect(read.messages[0]!.imageReferences).toEqual(references);
		expect(read.messages.at(-1)!.text).toBe("四角は紫です");
		expect(JSON.stringify(read)).not.toMatch(
			/base64|data:image|originalMime|bytes/,
		);
		await c.correct({
			messageId: "analysis",
			text: "読み取り結果は紫の四角2個。文字はR7K4です。",
		});
		const corrected = c.searchHistory("main", { query: "R7K4" }).candidates[0]!;
		expect(corrected.text).toContain("紫");
		expect(corrected.imageReferences).toEqual(references);
		for (const id of ["older-image", "newer-image"]) {
			await c.append({
				id,
				role: "user",
				conversationId: "main",
				text: "比較用",
				attachments: [image],
				runId: "multi",
				createdAt: new Date().toISOString(),
			});
		}
		await append(
			"multi-answer",
			"assistant",
			"最後に届いた画像への応答",
			"multi",
		);
		expect(
			store.read((db) => c.imageReferencesInTransaction(db, "multi-answer"))[0]!
				.messageId,
		).toBe("newer-image");
		await c.retract({ messageId: "newer-image" });
		expect(
			store.read((db) => c.imageReferencesInTransaction(db, "multi-answer")),
		).toEqual([]);
		const owner = {
			key: "image-history-test",
			conversationId: "main",
			deadline: Date.now() + 900000,
		};
		const beforeMove = store.read((db) =>
			c.historySearchInTransaction(db, owner, { query: "R7K4" }),
		);
		await store.write((db) =>
			c.moveToRunInTransaction(db, "image-input", "replacement"),
		);
		expect(
			store.read((db) =>
				c.validateHistoryInTransaction(db, owner, beforeMove.scope.scopeRef, [
					beforeMove.candidates[0]!,
				]),
			),
		).toBe(false);
		await c.retract({ messageId: "image-input" });
		expect(
			store.read((db) => c.imageReferencesInTransaction(db, "analysis")),
		).toEqual([]);
		expect(
			c.searchHistory("main", { query: "R7K4" }).candidates[0]!.imageReferences,
		).toBeUndefined();
	} finally {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
