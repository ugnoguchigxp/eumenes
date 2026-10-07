import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, WriterOwnedError } from "../../../infrastructure/sqlite";
import { createConversationService, migration } from "..";

test("conversation saves and survives reopen; second writer is refused", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-conversation-"));
	const file = join(dir, "test.sqlite3");
	try {
		const store = openStore(file, [migration]);
		const service = createConversationService(store);
		await service.append({
			id: "m1",
			conversationId: "c1",
			role: "user",
			text: "こんにちは",
			createdAt: "2026-01-01T00:00:00Z",
			runId: null,
		});
		expect(service.get("c1").revision).toBe(1);
		expect(() => openStore(file, [migration])).toThrow(WriterOwnedError);
		await store.close();
		const reopened = openStore(file, [migration]);
		expect(
			createConversationService(reopened).get("c1").messages[0]?.text,
		).toBe("こんにちは");
		await reopened.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
