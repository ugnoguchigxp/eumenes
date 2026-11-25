import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { insertAgencyWork, revokeAgencyWork } from "../repository/agency";
import {
	hasImageObservations,
	imageObservation,
	saveImageObservation,
} from "../repository/generated-images";
import type { DialogueDeps } from "../service/context";
import { generatedImageLines } from "../service/generated-image-text";
import { reservePendingImageObservations } from "../service/generated-images";
import { createResourceLedger } from "../service/resource-ledger";
import { openDialogueStore } from "./store.fixture";

/**
 * What the model saw of the images an assignment made, keyed by the agency's work root (the `work_id` its resources
 * are entered under): reserved once the conversation's next generation finds them, told while the assignment is held.
 */
const open: ReturnType<typeof openDialogueStore>[] = [];
afterEach(async () => {
	for (const h of open.splice(0)) {
		await h.store.close();
		rmSync(h.dir, { recursive: true, force: true });
	}
});

const IMAGE_URI = "eumenes://image/image_1";
const work = (rootId: string) => ({
	root_id: rootId,
	conversation_id: "main",
	epoch: 1,
	ticket_id: `ticket-${rootId}`,
	intent_id: "intent",
	candidate_id: "candidate",
	question: "猫の絵を描く",
	toolchain_revision_id: "toolchain:fake.image@1",
	deadline: Date.now() + 60_000,
	source_refs_json: "[]",
});

/** `imageRunId`: the run the generated image row carries (the work root for the agent's own research). */
function depsOf(imageRunId = "root-1") {
	const ledger = createResourceLedger({
		clock: () => new Date().toISOString(),
		id: () => crypto.randomUUID(),
	});
	const deps = {
		generatedImages: {
			versionInTransaction: (
				_db: unknown,
				query: { runId: string; artifactId: string },
			) => (query.runId === imageRunId ? `v:${query.artifactId}` : null),
			isConnectionCurrent: () => true,
			load: async () => {
				throw new Error("not loaded");
			},
		},
		// No model route: the observation is recorded as unavailable instead of being asked for.
		larm: {},
		queue: {},
		resourceLedger: ledger,
	} as unknown as DialogueDeps;
	return { deps, ledger };
}

test("hasImageObservations answers per conversation with one EXISTS, whatever the observation's state", () => {
	const h = openDialogueStore("eumenes-image-presence-");
	open.push(h);
	h.store.read((db) => {
		expect(hasImageObservations(db, "main")).toBe(false);
	});
	return h.store
		.write((db) => {
			saveImageObservation(db, {
				rootId: "root-1",
				conversationId: "main",
				images: [],
				state: "pending",
			});
		})
		.then(() =>
			h.store.read((db) => {
				expect(hasImageObservations(db, "main")).toBe(true);
				expect(hasImageObservations(db, "other")).toBe(false);
			}),
		);
});

test("the images an assignment made are reserved under its work root and told by their numbers; a forgotten assignment's are dropped", async () => {
	const h = openDialogueStore("eumenes-image-root-");
	open.push(h);
	const { deps, ledger } = depsOf();
	await h.store.write((db) => {
		insertAgencyWork(db, work("root-1"));
		ledger.enterLinksInTransaction(db, {
			conversationId: "main",
			workId: "root-1",
			links: [{ uri: IMAGE_URI, kind: "image", label: "猫の絵" }],
		});
		// Images found by hand or made by another conversation's assignment are no part of it.
		ledger.enterInTransaction(db, {
			conversationId: "main",
			uri: "eumenes://image/image_9",
			kind: "image",
			label: "拾った画像",
			source: "found",
		});
		reservePendingImageObservations(deps, db, "main");
	});
	await h.store.read((db) => {
		const record = imageObservation(db, "root-1");
		expect(record).toMatchObject({
			rootId: "root-1",
			conversationId: "main",
			state: "unavailable",
			reason: "route_unavailable",
			images: [{ uri: IMAGE_URI, id: "image_1", version: "v:image_1" }],
		});
		const lines = generatedImageLines(deps, db, "main", null);
		expect(lines).toEqual([
			{
				rootId: "root-1",
				line: "- a1 画像は受領済み。画像の内容は未確認",
			},
		]);
		// Images made before the recent conversation begins are no part of the input.
		expect(generatedImageLines(deps, db, "main", Date.now() + 60_000)).toEqual(
			[],
		);
	});
	// A second look finds the assignment covered already.
	await h.store.write((db) =>
		reservePendingImageObservations(deps, db, "main"),
	);
	// The agency forgot the assignment: nothing is told, and the record goes with the next look.
	await h.store.write((db) => revokeAgencyWork(db, "root-1"));
	h.store.read((db) => {
		expect(generatedImageLines(deps, db, "main", null)).toEqual([]);
	});
	await h.store.write((db) =>
		reservePendingImageObservations(deps, db, "main"),
	);
	h.store.read((db) => {
		expect(imageObservation(db, "root-1")).toBeNull();
	});
});

test("the images made for a user's assignment are found under the run of the user's words, not the work root", async () => {
	const h = openDialogueStore("eumenes-image-user-run-");
	open.push(h);
	const { deps, ledger } = depsOf("user-run");
	await h.store.write((db) => {
		db.run(
			"INSERT INTO conversations (id, created_at) VALUES ('main', '2026-10-31T00:00:00.000Z')",
		);
		db.run(
			"INSERT INTO messages (id, conversation_id, role, text, created_at) VALUES ('m', 'main', 'user', '猫を描いて', '2026-10-31T00:00:00.000Z')",
		);
		db.run(
			`INSERT INTO dialogue_runs (id, request_id, conversation_id, status, revision, input_message_id, created_at, updated_at)
			VALUES ('user-run', 'req', 'main', 'completed', 1, 'm', '2026-10-31T00:00:00.000Z', '2026-10-31T00:00:00.000Z')`,
		);
		insertAgencyWork(db, work("root-2"));
		ledger.enterLinksInTransaction(db, {
			conversationId: "main",
			workId: "root-2",
			links: [{ uri: IMAGE_URI, kind: "image", label: "猫の絵" }],
		});
		reservePendingImageObservations(deps, db, "main");
	});
	h.store.read((db) => {
		expect(imageObservation(db, "root-2")).toMatchObject({
			rootId: "root-2",
			state: "unavailable",
			reason: "route_unavailable",
			images: [
				{
					uri: IMAGE_URI,
					id: "image_1",
					version: "v:image_1",
					runId: "user-run",
				},
			],
		});
		expect(generatedImageLines(deps, db, "main", null)).toEqual([
			{ rootId: "root-2", line: "- a1 画像は受領済み。画像の内容は未確認" },
		]);
	});
});
