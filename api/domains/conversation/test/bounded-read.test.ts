import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import {
	answerDeliveryMigration,
	avatarMotionMigration,
	createConversationService,
	migration,
} from "..";

async function withService(
	run: (
		service: ReturnType<typeof createConversationService>,
		store: ReturnType<typeof openStore>,
	) => Promise<void>,
) {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-conversation-"));
	const store = openStore(join(dir, "test.sqlite3"), [
		migration,
		avatarMotionMigration,
		answerDeliveryMigration,
	]);
	try {
		await run(createConversationService(store), store);
	} finally {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
}
const msg = (
	n: number,
	role: "user" | "assistant" = "user",
	runId: string | null = null,
) => ({
	id: `m${n}`,
	conversationId: "c1",
	role,
	text: `t${n}`,
	createdAt: "2026-01-01T00:00:00Z",
	runId,
});

test("an invalid stored delivery is dropped for that row only", async () => {
	await withService(async (service, store) => {
		await service.append(msg(1));
		await service.append(msg(2, "assistant", "r1"));
		await service.append(msg(3, "assistant", "r2"));
		await store.write((db) => {
			db.query(
				"INSERT INTO answer_deliveries (run_id, conversation_id, delivery) VALUES (?, ?, ?)",
			).run("r1", "c1", JSON.stringify({ nonsense: true }));
		});
		const conversation = service.get("c1");
		expect(conversation.messages).toHaveLength(3);
		expect(conversation.messages[1]?.delivery).toBeUndefined();
		expect(service.message("m2")?.text).toBe("t2");
		expect(service.message("m2")?.delivery).toBeUndefined();
	});
});

test("get keeps the newest 2000 messages and reports hasMore", async () => {
	await withService(async (service, store) => {
		await service.append(msg(0));
		await store.write((db) => {
			const insert = db.query(
				"INSERT INTO messages (id, conversation_id, role, text, created_at, run_id) VALUES (?, 'c1', 'user', ?, '2026-01-01T00:00:00Z', NULL)",
			);
			for (let n = 1; n <= 2000; n++) insert.run(`m${n}`, `t${n}`);
		});
		const conversation = service.get("c1");
		expect(conversation.messages).toHaveLength(2000);
		expect(conversation.hasMore).toBe(true);
		expect(conversation.messages[0]?.id).toBe("m1");
		expect(conversation.messages.at(-1)?.id).toBe("m2000");
	});
});

test("turnsBefore returns the preceding messages oldest first", async () => {
	await withService(async (service) => {
		for (let n = 1; n <= 6; n++) await service.append(msg(n));
		expect(service.turnsBefore("c1", "m5", 3).map((m) => m.id)).toEqual([
			"m2",
			"m3",
			"m4",
		]);
		expect(service.turnsBefore("c1", "nope", 3)).toEqual([]);
		expect(service.get("c1").hasMore).toBeUndefined();
	});
});
