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
	close() {},
	exited: new Promise(() => {}),
});

test("Claude Code screen is registered as a launcher and reads the live session list", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-terminals-screen-"));
	const store = openStore(join(dir, "db"), migrations);
	try {
		const caps = createCapabilities(store, new Set(["claude-code"]), {
			bundleHost: offlineBundleHost,
		});
		await caps.seed();
		const entries = store
			.read((db) => caps.artifactsInTransaction(db))
			.filter((entry) => entry.artifactId === "terminals.workspace");
		expect(entries).toEqual([
			expect.objectContaining({
				artifactRevisionId: "artifact:terminals.workspace@2",
				adapterRefs: [TERMINALS_ADAPTER_REF],
				title: "Claude Code",
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

test("a Claude Code request is handed over once per request id", () => {
	const commands: Array<readonly string[]> = [];
	const terminals = createTerminals({
		command: ["claude"],
		spawn: (request) => {
			commands.push(request.command);
			return spawn(request);
		},
	});
	const adapter = createTerminalsAdapter(terminals);
	const tx = undefined as unknown as Parameters<
		typeof adapter.invokeInTransaction
	>[0];
	const request = {
		operationName: "claude-code.request",
		input: { prompt: "README を直して", task: "README 修正" },
		requestId: crypto.randomUUID(),
		issuedAt: new Date().toISOString(),
		origin: { kind: "ui" as const, scope: "s", actionRequestId: "a" },
	};
	const first = adapter.invokeInTransaction(tx, request);
	expect(first).toMatchObject({
		replay: false,
		receipt: {
			title: "Claude Code 1",
			task: "README 修正",
			run: 1,
			started: true,
		},
		answerContext: {
			delivered: "started",
			task: "README 修正",
			completed: false,
			reportedWhenDone: true,
		},
	});
	expect(adapter.invokeInTransaction(tx, request)).toMatchObject({
		replay: true,
		receipt: first.receipt,
	});
	expect(commands).toHaveLength(1);
	expect(adapter.readInTransaction(tx, request.requestId)?.receipt).toEqual(
		first.receipt,
	);
	expect(adapter.readInTransaction(tx, "unknown")).toBeNull();
	expect(() =>
		adapter.invokeInTransaction(tx, {
			...request,
			requestId: crypto.randomUUID(),
			input: { prompt: "", task: "x" },
		}),
	).toThrow();
	expect(adapter.snapshotInTransaction(tx)).toEqual({
		limit: 4,
		sessions: [
			{
				title: "Claude Code 1",
				status: "running",
				activity: "working",
				task: "README 修正",
			},
		],
	});
	terminals.closeAll();
});
