import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../infrastructure/sqlite";
import { migrations } from "./migrations";
import { createSettings } from "../domains/settings";
import { createInference } from "../domains/inference";
import {
	capacityFixture,
	messages,
	owner,
} from "../domains/larm/test/agent-capacity.fixture";

test("the real inference composition passes main agent metadata into the 200k create and keeps sub calls on default capacity", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-agent-capacity-"));
	const dbPath = join(dir, "fixture.db"),
		store = openStore(dbPath, migrations);
	const settings = await createSettings(store, { dbPath, env: {} });
	const f = capacityFixture(),
		saved = settings.get();
	saved.larm.baseUrl = f.config.baseUrl;
	saved.larm.profile = f.config.profile;
	saved.routes.llm.mode = "larm-only";
	saved.routes.llm.cloudAllowed = false;
	await settings.apply({
		requestId: crypto.randomUUID(),
		expectedRevision: saved.revision,
		settings: saved,
		keys: [],
	});
	const inference = createInference(store, settings, {
		token: f.config.token,
		fetch: f.config.fetch,
	});
	try {
		for (const role of ["main", "subagent", "main"] as const) {
			const requestId = await store.write((db) =>
				inference.captureInTransaction!(
					db,
					crypto.randomUUID(),
					"llm",
					Date.now() + 5000,
				),
			);
			const receipt = await inference.executeStream!(
				requestId,
				messages,
				AbortSignal.timeout(5000),
				() => {},
				undefined,
				undefined,
				owner(role),
			);
			expect(receipt.value).toBe("ok");
		}
		expect(f.creates).toHaveLength(2);
		expect(f.creates[0]!.body.contextTokens).toBe(200000);
		expect(f.creates[1]!.body).not.toHaveProperty("contextTokens");
		expect(f.generations[0]!.id).toBe(f.generations[2]!.id);
		expect(f.generations[1]!.id).not.toBe(f.generations[0]!.id);
	} finally {
		await inference.close();
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
