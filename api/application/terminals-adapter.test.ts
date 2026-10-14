import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCapabilities } from "../domains/capabilities";
import {
	createTerminals,
	migrations as terminalsMigrations,
	type SpawnPty,
} from "../domains/terminals";
import { openStore } from "../infrastructure/sqlite";
import { migrations } from "./migrations";
import {
	createTerminalsAdapter,
	TERMINALS_ADAPTER_REF,
} from "./terminals-adapter";
import { offlineBundleHost } from "./toolchain-adapters";

const SESSIONS = "query:terminals.sessions@1";
/** The host registers the terminals table; added here until it does. */
const withTerminals = (list: typeof migrations) => [
	...list,
	...terminalsMigrations.filter(
		(entry) => !list.some((known) => known.id === entry.id),
	),
];
const spawn: SpawnPty = () => ({
	write() {},
	resize() {},
	kill() {},
	close() {},
	exited: new Promise(() => {}),
});

test("Claude Code screen is registered as a launcher and reads the live session list", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-terminals-screen-"));
	const store = openStore(join(dir, "db"), withTerminals(migrations));
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

		const terminals = createTerminals({ command: ["claude"], spawn, store });
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
			data: {
				sessions: [
					{ id: session.id, status: "running", run: 1, owner: "direct" },
				],
			},
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

test("a Claude Code request is saved once per request id and read back from the table", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-terminals-adapter-"));
	const store = openStore(join(dir, "db"), withTerminals(migrations));
	const commands: Array<readonly string[]> = [];
	const terminals = createTerminals({
		command: ["claude"],
		spawn: (request) => {
			commands.push(request.command);
			return spawn(request);
		},
		store,
		hookBaseUrl: "http://127.0.0.1:8787",
		curl: "curl",
	});
	try {
		const adapter = createTerminalsAdapter(terminals);
		type Invocation = Parameters<typeof adapter.invokeInTransaction>[1];
		const request: Invocation = {
			operationName: "claude-code.request",
			input: { prompt: "README を直して", task: "README 修正" },
			requestId: crypto.randomUUID(),
			issuedAt: new Date().toISOString(),
			// Only the conversation id is read from the origin.
			origin: {
				kind: "conversation",
				conversationId: "main",
			} as Invocation["origin"],
		};
		const invoke = (input: Invocation) =>
			store.write((tx) => adapter.invokeInTransaction(tx, input));
		const first = await invoke(request);
		expect(first).toMatchObject({
			replay: false,
			receipt: { task: "README 修正", target: "current" },
			answerContext: {
				delivered: "queued",
				task: "README 修正",
				completed: false,
				reportedWhenDone: true,
			},
		});
		await terminals.settled();
		expect(commands).toHaveLength(1);
		expect(commands[0]!.at(-1)).toBe("README を直して");
		// The same operation request id is a replay: the saved request, nothing sent again.
		expect(await invoke(request)).toMatchObject({
			replay: true,
			receipt: first.receipt,
		});
		await terminals.settled();
		expect(commands).toHaveLength(1);
		const read = store.read((db) =>
			adapter.readInTransaction(db, request.requestId),
		);
		expect(read?.receipt).toEqual(first.receipt);
		expect(read?.receiptRef.digest).toBe(first.receiptRef.digest);
		expect(
			store.read((db) => adapter.readInTransaction(db, "unknown")),
		).toBeNull();
		// The request is a direct one of the conversation, with no git restriction of its own.
		const attemptId = (first.receipt as { attemptId: string }).attemptId;
		expect(
			store.read((db) => terminals.requestInTransaction(db, attemptId)),
		).toMatchObject({
			owner: "direct",
			mode: "work",
			origin: "conversation",
			conversationId: "main",
			state: "delivered",
		});
		await expect(
			invoke({
				...request,
				requestId: crypto.randomUUID(),
				input: { prompt: "", task: "x" },
			}),
		).rejects.toThrow();
		const named = await invoke({
			...request,
			requestId: crypto.randomUUID(),
			input: { prompt: "別のセッションで", task: "別件", session: "new" },
		});
		expect(named.receipt).toMatchObject({ target: "new" });
		await terminals.settled();
		expect(store.read((db) => adapter.snapshotInTransaction(db))).toEqual({
			limit: 4,
			sessions: [
				{
					title: "Claude Code 1",
					status: "running",
					activity: "working",
					task: "README 修正",
				},
				{
					title: "Claude Code 2",
					status: "running",
					activity: "working",
					task: "別件",
				},
			],
		});
	} finally {
		terminals.closeAll();
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
