import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { openDialogueStore } from "./store.fixture";
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
		// The retired TODO ledger's references name no live record: they are not this domain's to judge.
		expect(
			state.staleSourcesInTransaction(db, ['host-work:["missing",1]']),
		).toEqual([]);
	});
	expect(reads).toBe(0);
	h.store.read((db) => {
		expect(() =>
			state.staleSourcesInTransaction(db, ["capability:a@1"]),
		).toThrow("catalog unavailable");
	});
	expect(reads).toBe(1);
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
	await h.store.write(() => {
		expect(staleAgencySources(refs, catalog)).toEqual(["capability:old@1"]);
		expect(reads).toBe(1);
		available = ["b@2"];
		expect(staleAgencySources(refs, catalog)).toEqual([
			"capability:a@1",
			"capability:old@1",
		]);
		expect(reads).toBe(2);
	});
});
