import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCapabilities } from "../domains/capabilities";
import { createTerminals, type SpawnPty } from "../domains/terminals";
import { openStore } from "../infrastructure/sqlite";
import { migrations } from "./migrations";
import {
	createTerminalsAdapter,
	TERMINALS_ADAPTER_REF,
} from "./terminals-adapter";
import { offlineBundleHost } from "./toolchain-adapters";

const SESSIONS = "query:terminals.sessions@1";
const spawn: SpawnPty = () => ({
	write() {},
	resize() {},
	kill() {},
	exited: new Promise(() => {}),
});

test("terminal screen is registered as a launcher and reads the live session list", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-terminals-screen-"));
	const store = openStore(join(dir, "db"), migrations);
	try {
		const caps = createCapabilities(store, new Set(), {
			bundleHost: offlineBundleHost,
		});
		await caps.seed();
		const entries = store
			.read((db) => caps.artifactsInTransaction(db))
			.filter((entry) => entry.artifactId === "terminals.workspace");
		expect(entries).toEqual([
			expect.objectContaining({
				artifactRevisionId: "artifact:terminals.workspace@1",
				adapterRefs: [TERMINALS_ADAPTER_REF],
				title: "ターミナル",
			}),
		]);

		const terminals = createTerminals({ command: ["claude"], spawn });
		const adapter = createTerminalsAdapter(terminals);
		const read = () =>
			store.read((db) => adapter.sourceInTransaction(db, SESSIONS, undefined));
		expect(read()).toMatchObject({
			revision: 0,
			data: { available: true, sessions: [] },
		});
		const session = terminals.start({ cols: 80, rows: 24 });
		expect(read()).toMatchObject({
			revision: 1,
			data: { sessions: [{ id: session.id, status: "running", run: 1 }] },
		});
		expect(
			store.read((db) => adapter.sourceInTransaction(db, SESSIONS, "other")),
		).toBeNull();
		expect(store.read((db) => adapter.availableInTransaction(db))).toBe(true);
		const missing = createTerminalsAdapter(
			createTerminals({ command: null, spawn }),
		);
		expect(store.read((db) => missing.availableInTransaction(db))).toBe(false);
	} finally {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
