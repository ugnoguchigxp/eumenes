import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import { hostDelivery } from "../../delivery";
import {
	answerDeliveryMigration,
	avatarMotionMigration,
	createConversationService,
	migration,
	migrations,
} from "..";

const utterance = {
	id: "agency:s1:t1",
	conversationId: "main",
	role: "assistant" as const,
	text: "おっ、雨やんだね。",
	createdAt: "2026-10-24T00:00:00Z",
	runId: null,
};

test("a runless message keeps its host delivery; a message without one has none", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-message-delivery-"));
	try {
		const store = openStore(join(dir, "db"), migrations);
		const service = createConversationService(store);
		const delivery = hostDelivery("surprise");
		await store.write((db) =>
			service.appendInTransaction(db, { ...utterance, delivery }),
		);
		await service.append({ ...utterance, id: "agency:s1:t2" });
		const [first, second] = service.get("main").messages;
		expect(first?.delivery).toEqual(delivery);
		expect(first?.delivery?.tone).toBe("excited");
		expect(second?.delivery).toBeUndefined();
		expect(service.message("agency:s1:t1")?.delivery?.source).toBe("host");
		await store.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("without the table a host delivery is refused, never dropped", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-message-delivery-"));
	try {
		const store = openStore(join(dir, "db"), [
			migration,
			avatarMotionMigration,
			answerDeliveryMigration,
		]);
		const service = createConversationService(store);
		await expect(
			store.write((db) =>
				service.appendInTransaction(db, {
					...utterance,
					delivery: hostDelivery("joy"),
				}),
			),
		).rejects.toThrow("message_delivery_unavailable");
		await service.append(utterance);
		expect(service.get("main").messages[0]?.delivery).toBeUndefined();
		await store.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
