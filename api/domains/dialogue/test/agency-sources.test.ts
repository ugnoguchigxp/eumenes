import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { openDialogueStore } from "./store.fixture";
import {
	insertWork,
	updateWork,
	insertConfirmation,
	confirmationById,
	withdrawConfirmation,
} from "../repository/work";
import { sha256Hex } from "../../../infrastructure/digest";
import { staleAgencySources } from "../service/agency-sources";
import { createAgencyStatePort } from "../service/agency-state";
import type { ToolchainRoutingPort } from "../contracts/toolchains";
const open: ReturnType<typeof openDialogueStore>[] = [];
afterEach(async () => {
	for (const h of open.splice(0)) {
		await h.store.close();
		rmSync(h.dir, { recursive: true, force: true });
	}
});
test("unrelated source checks do not rebuild or depend on the capability catalog", () => {
	const h = openDialogueStore("agency-source-lazy-");
	open.push(h);
	let reads = 0;
	const state = createAgencyStatePort({
		now: () => 0,
		toolchains: {
			catalogInTransaction() {
				reads++;
				throw new Error("catalog unavailable");
			},
		} as unknown as ToolchainRoutingPort,
	});
	h.store.read((db) => {
		expect(state.staleSourcesInTransaction(db, [])).toEqual([]);
		expect(
			state.staleSourcesInTransaction(db, ["message:a", "memory:b"]),
		).toEqual([]);
		expect(
			state.staleSourcesInTransaction(db, ['host-work:["missing",1]']),
		).toEqual(['host-work:["missing",1]']);
	});
	expect(reads).toBe(0);
	h.store.read((db) => {
		expect(() =>
			state.staleSourcesInTransaction(db, ["capability:a@1"]),
		).toThrow("catalog unavailable");
	});
	expect(reads).toBe(1);
});
test("TODO revision changes and withdrawn capabilities invalidate only their own source versions", async () => {
	const h = openDialogueStore("agency-source-versions-");
	open.push(h);
	await h.store.write((db) => {
		const row = insertWork(db, {
			id: "work-a",
			conversationId: "B",
			runId: "run-a",
			toolchainId: "chain",
			toolchainRevisionId: "chain@1",
			execution: "queued",
			request: "調べて",
			title: "調査",
			sourceRef: null,
			createdAt: new Date().toISOString(),
			messageIds: [],
			dedupeKey: "a",
		});
		const ref = `host-work:${JSON.stringify([row.id, row.revision])}`;
		const refs = [ref, "capability:chain@1", "unrelated-input"];
		expect(staleAgencySources(db, refs, () => ["chain@1"])).toEqual([]);
		expect(
			updateWork(
				db,
				row.id,
				row.revision,
				{ status: "done" },
				new Date().toISOString(),
			),
		).toBe(true);
		expect(staleAgencySources(db, refs, () => ["chain@1"])).toEqual([ref]);
		expect(staleAgencySources(db, refs, () => [])).toEqual([
			ref,
			"capability:chain@1",
		]);
	});
});

test("capabilities are read once per check and revocation is visible in the same transaction", async () => {
	const h = openDialogueStore("agency-source-capabilities-");
	open.push(h);
	let available = ["a@1", "b@2"];
	let reads = 0;
	const catalog = () => {
		reads++;
		return available;
	};
	const refs = [
		"capability:a@1",
		"memory:unrelated",
		"capability:b@2",
		"capability:old@1",
	];
	await h.store.write((db) => {
		expect(staleAgencySources(db, refs, catalog)).toEqual(["capability:old@1"]);
		expect(reads).toBe(1);
		available = ["b@2"];
		expect(staleAgencySources(db, refs, catalog)).toEqual([
			"capability:a@1",
			"capability:old@1",
		]);
		expect(reads).toBe(2);
	});
});

test("withdrawn confirmations still invalidate their source without reading capabilities", async () => {
	const h = openDialogueStore("agency-source-confirmation-");
	open.push(h);
	await h.store.write((db) => {
		insertConfirmation(
			db,
			{
				id: "confirmation",
				conversationId: "c",
				toolchainId: "chain",
				toolchainRevisionId: "chain@1",
				request: "fixture",
				inputs: null,
				target: null,
				targetLabel: null,
				resolveUnsaved: null,
				words: null,
				impact: "none",
				statementDeliveryKey: "fixture",
				issuedAt: "2026-11-15T00:00:00Z",
				expiresAt: "2026-11-16T00:00:00Z",
			},
			[],
		);
		const row = confirmationById(db, "confirmation")!;
		const ref = `host-confirmation:${JSON.stringify([row.id, sha256Hex(JSON.stringify(row))])}`;
		const unavailable = () => {
			throw new Error("catalog must not be read");
		};
		expect(staleAgencySources(db, [ref], unavailable)).toEqual([]);
		expect(withdrawConfirmation(db, "c", row.ref, "2026-11-15T01:00:00Z")).toBe(
			true,
		);
		expect(staleAgencySources(db, [ref], unavailable)).toEqual([ref]);
	});
});
