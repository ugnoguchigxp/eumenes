import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../infrastructure/config";
import { createLifecycleRunner } from "./lifecycle";
import { createLifecycles } from "./server-lifecycles";
import { buildServices } from "./server-services";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

test("a forget revokes the running agent attempt that stood on the forgotten message, in the forget's own transaction", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-purge-"));
	dirs.push(dir);
	const services = await buildServices(
		loadConfig({
			EUMENES_DB: join(dir, "db.sqlite3"),
			EUMENES_TOOLCHAIN_ENABLED: "0",
			EUMENES_WORLD: "protect",
		}),
	);
	try {
		const messageId = crypto.randomUUID();
		await services.store.write((db) => {
			services.conversation.appendInTransaction(db, {
				id: messageId,
				conversationId: "main",
				role: "user",
				text: "forget me",
				createdAt: new Date().toISOString(),
			} as never);
			db.query(
				"INSERT INTO inference_requests(id,subject,purpose,snapshot,deadline) VALUES('r1','s','llm','{}',?)",
			).run(Date.now() + 60_000);
			db.query(
				"INSERT INTO inference_attempts(id,request_id,source,status,started,refs) VALUES('a1','r1','cloud','running',?,?)",
			).run(
				Date.now(),
				JSON.stringify({ messageIds: [messageId], itemIds: [] }),
			);
			db.query(
				"INSERT INTO inference_attempts(id,request_id,source,status,started,refs) VALUES('a2','r1','cloud','running',?,?)",
			).run(Date.now(), JSON.stringify({ messageIds: ["other"], itemIds: [] }));
		});
		await services.memory.recover();
		await services.memory.forget({
			conversationId: "main",
			itemIds: [],
			messageIds: [messageId],
		});
		expect(
			services.store.read((db) =>
				db.query("SELECT id,status FROM inference_attempts ORDER BY id").all(),
			),
		).toEqual([
			{ id: "a1", status: "revoked" },
			{ id: "a2", status: "running" },
		]);
	} finally {
		const items = createLifecycles(services, { name: "http", close: () => {} });
		await createLifecycleRunner(items).closeAll(15_000);
	}
}, 30_000);
