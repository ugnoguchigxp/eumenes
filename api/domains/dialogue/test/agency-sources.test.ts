import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { openDialogueStore } from "./store.fixture";
import { insertWork, updateWork } from "../repository/work";
import { staleAgencySources } from "../service/agency-sources";
const open: ReturnType<typeof openDialogueStore>[] = [];
afterEach(async () => {
	for (const h of open.splice(0)) {
		await h.store.close();
		rmSync(h.dir, { recursive: true, force: true });
	}
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
		expect(staleAgencySources(db, refs, ["chain@1"])).toEqual([]);
		expect(
			updateWork(
				db,
				row.id,
				row.revision,
				{ status: "done" },
				new Date().toISOString(),
			),
		).toBe(true);
		expect(staleAgencySources(db, refs, ["chain@1"])).toEqual([ref]);
		expect(staleAgencySources(db, refs, [])).toEqual([
			ref,
			"capability:chain@1",
		]);
	});
});
