import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import type { LarmPort } from "../../larm";
import { createInference, type InferenceService } from "../../inference";
import { createSettings } from "../../settings";
import { routeConversation } from "../service/harness";
import { settings } from "./harness.fixture";
import { openDialogueStore, removeDialogueStore } from "./store.fixture";

/**
 * A voice turn's llm request is captured under the utterance id and bound to its run: the run's route is found
 * from it by the run id, on the real inference service.
 */
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const close of cleanup.splice(0)) await close();
});

async function setup() {
	const { dir, store } = openDialogueStore("eumenes-harness-voice-");
	const saved = await createSettings(store, {
		dbPath: join(dir, "db.sqlite3"),
		env: {},
	});
	const larm = {
		decisionModel: () => null,
		status: () => ({ state: "unconfigured", capabilities: [] }),
		connect: async () => {},
		close: async () => {},
	} as unknown as LarmPort;
	const inference: InferenceService = createInference(store, saved, {
		larmFactory: () => larm,
	});
	cleanup.push(async () => {
		await inference.close();
		await store.close();
		removeDialogueStore(dir);
	});
	return { store, inference };
}

test("the route of a voice run is found from its bound llm request by the run id", async () => {
	const { store, inference } = await setup();
	const snapshot = settings({ mode: "cloud-only" });
	routeConversation(snapshot);
	await store.write((db) => {
		inference.captureInTransaction!(
			db,
			"utterance-1",
			"llm",
			Date.now() + 60_000,
			snapshot,
		);
		inference.bindInTransaction!(
			db,
			"utterance-1",
			"run-1",
			Date.now() + 60_000,
		);
	});
	const found = store.read((db) => inference.snapshotFor!(db, "run-1"));
	expect(found?.routes.llm).toMatchObject({
		mode: "cloud-only",
		cloudAllowed: true,
	});
});
