import { afterEach, expect, test } from "bun:test";
import { z } from "zod";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrowser } from "../../domains/browser";
import {
	connect,
	FakeDriver,
	FakeEncoder,
	FakeFiles,
	fakeResolver,
	until,
	WEB,
	type Env,
} from "../../domains/browser/test/fakes";
import { createCapabilities, validators } from "../../domains/capabilities";
import { createQueue } from "../../domains/queue";
import {
	createAdapterRegistry,
	type AdapterOrigin,
} from "../../domains/tool-runtime";
import { createToolchainHistory } from "../../domains/toolchain-history";
import { openStore } from "../../infrastructure/sqlite";
import { migrations } from "../migrations";
import {
	createSchemaProvider,
	hostAdapterDescriptions,
	offlineBundleHost,
} from "../toolchain/toolchain-adapters";
import { createToolchainRouting } from "../toolchain/toolchain-routing";
import { createBrowserAdapter } from "./browser-adapter";
import { registerBrowserEffects } from "./browser-effects";

const dirs: string[] = [];
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const close of closers.splice(0)) await close();
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

const noRequests = { userMessageInTransaction: () => null };
const REVISION = "toolchain:browser.capture@1";
const BINDING = "binding:browser.capture@1";
const conversation: AdapterOrigin = {
	kind: "conversation",
	owner: { rootRunId: "run-1", taskId: "task-1", cancelEpoch: 0 },
	runId: "run-1",
	conversationId: "c1",
	messageId: "m1",
};

/** The shipped bundle over the real adapter, the real routing and the real browser domain (fake driver). */
async function setup() {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-browser-toolchain-"));
	dirs.push(dir);
	const store = openStore(join(dir, "db"), migrations);
	const queue = createQueue(store, { pollMs: 5 });
	const driver = new FakeDriver();
	const service = createBrowser({
		store,
		queue,
		driver,
		encoder: new FakeEncoder(),
		files: new FakeFiles(),
		webOrigins: [WEB],
		resolveHost: fakeResolver(),
	});
	queue.start();
	closers.push(async () => {
		await queue.close(100);
		await store.close();
	});
	const adapter = createBrowserAdapter(
		service,
		registerBrowserEffects({ queue, service }),
		noRequests,
	);
	const capabilities = createCapabilities(
		store,
		new Set(["browser", "web", "timer", "image"]),
		{ bundleHost: offlineBundleHost },
	);
	await capabilities.seed();
	const routing = createToolchainRouting(
		capabilities,
		createToolchainHistory(store),
		async () => undefined,
		createAdapterRegistry([adapter]),
		createSchemaProvider(capabilities),
	);
	return { store, queue, driver, service, adapter, routing, capabilities, dir };
}

test("the shipped adapter description is the one the bundle was checked against", () => {
	const offline = hostAdapterDescriptions.find(
		(a) => a.ref === "adapter:browser@1",
	)!;
	const real = createBrowserAdapter(
		{} as never,
		{} as never,
		noRequests,
	).describe();
	expect([...offline.describe().operations]).toEqual([...real.operations]);
	expect(offline.describe().availability).toBe(real.availability);
});

test("the capture toolchain is a command toolchain whose adapter is available before any connection", async () => {
	const s = await setup();
	const runtime = s.store.read((db) =>
		s.routing.catalogInTransaction(db).find((c) => c.revisionId === REVISION),
	);
	expect(runtime).toMatchObject({
		id: "browser.capture",
		runtime: {
			execution: "command",
			binding: {
				bindingRevisionId: BINDING,
				adapterRef: "adapter:browser@1",
				artifactRevisionId: "artifact:browser.workspace@1",
				available: true,
			},
		},
	});
});

test("the command specialist gets the capture tools with flat schemas and the tabs it may name", async () => {
	const s = await setup();
	const tabRef = await connect(s as unknown as Env);
	const set = s.store.read((db) =>
		s.routing.commandSetInTransaction(db, REVISION),
	);
	expect(set.binding?.agentTurn).toBeUndefined();
	expect(set.binding?.tools.map((t) => t.operationName)).toEqual([
		"browser.workspace.open",
		"browser.connect",
		"browser.capture.start",
		"browser.capture.status",
		"browser.capture.cancel",
	]);
	for (const tool of set.binding!.tools) {
		expect(tool.schema.type).toBe("object");
		expect(tool.summary.length).toBeGreaterThan(0);
	}
	const snapshot = s.store.read((db) =>
		s.routing.bound!.snapshotInTransaction(db, BINDING),
	) as { connection: { state: string }; tabs: Array<{ tabRef: string }> };
	expect(snapshot.connection.state).toBe("connected");
	expect(snapshot.tabs.map((t) => t.tabRef)).toEqual([tabRef]);
	const start = set.binding!.tools.find(
		(t) => t.operationName === "browser.capture.start",
	)!;
	expect(
		s.routing.bound!.parseInvocation(set.binding!, start.id, {
			tabRef,
			range: "full-page",
		}),
	).toMatchObject({ ok: true, operationName: "browser.capture.start" });
	for (const bad of [
		{ tabRef, range: "element" },
		{ tabRef, range: "viewport", quality: 100 },
		{ range: "viewport" },
	])
		expect(
			s.routing.bound!.parseInvocation(set.binding!, start.id, bad),
		).toEqual({ ok: false, code: "toolchain_command_invalid_arguments" });
});

test("a validated invocation reaches the adapter and starts a capture of that tab", async () => {
	const s = await setup();
	const tabRef = await connect(s as unknown as Env);
	const saved = await s.store.write((db) =>
		s.adapter.invokeInTransaction(db, {
			operationName: "browser.capture.start",
			input: { tabRef, range: "viewport" },
			requestId: crypto.randomUUID(),
			issuedAt: new Date().toISOString(),
			origin: conversation,
		}),
	);
	expect(saved.receipt).toMatchObject({ action: "capture.start" });
	await until(() => s.driver.calls.includes("measure"));
});

const OPERATE = "toolchain:browser.operate@2";
const OPERATE_BINDING = "binding:browser.operate@2";

test("the operate toolchain is a command toolchain that starts a single-shot task with the binding's policy", async () => {
	const s = await setup();
	const runtime = s.store.read((db) =>
		s.routing.catalogInTransaction(db).find((c) => c.revisionId === OPERATE),
	);
	expect(runtime).toMatchObject({
		id: "browser.operate",
		runtime: {
			execution: "command",
			binding: {
				bindingRevisionId: OPERATE_BINDING,
				adapterRef: "adapter:browser@1",
				artifactRevisionId: "artifact:browser.workspace@2",
				available: true,
			},
		},
	});
	const set = s.store.read((db) =>
		s.routing.commandSetInTransaction(db, OPERATE),
	);
	expect(set.binding?.agentTurn).toEqual({
		maxModelCalls: 12,
		retries: { default: 1 },
	});
	// The command step sees the acceptance tools only; the page tools belong to the operator package.
	expect(set.binding?.tools.map((t) => t.operationName)).toEqual([
		"browser.workspace.open",
		"browser.connect",
		"browser.task.begin",
		"browser.task.status",
		"browser.task.cancel",
	]);
	const start = set.binding!.tools.find(
		(t) => t.operationName === "browser.task.begin",
	)!;
	expect(start.schema.type).toBe("object");
	const tabRef = crypto.randomUUID();
	expect(
		s.routing.bound!.parseInvocation(set.binding!, start.id, {
			request: "このタブで商品名を検索して",
			tabRef,
		}),
	).toMatchObject({ ok: true, operationName: "browser.task.begin" });
	// A follow-up after the user's approval names the task it continues.
	expect(
		s.routing.bound!.parseInvocation(set.binding!, start.id, {
			request: "はい、送ってください",
			continueFrom: crypto.randomUUID(),
			approvePending: true,
		}),
	).toMatchObject({ ok: true, operationName: "browser.task.begin" });
	for (const bad of [
		{},
		{ request: "" },
		{ request: "はい", approvePending: true },
		{ request: "はい", continueFrom: "not-a-uuid" },
		{ request: "開く", tabRef: "not-a-uuid" },
		{ request: "開く", quality: 1 },
	])
		expect(
			s.routing.bound!.parseInvocation(set.binding!, start.id, bad),
		).toEqual({ ok: false, code: "toolchain_command_invalid_arguments" });
});

test("the acceptance package, with the operator package it runs, still fits the context budget", async () => {
	const s = await setup();
	const owner = { rootRunId: "run-1", taskId: "task-1", cancelEpoch: 0 };
	const prepared = s.store.read((db) =>
		s.capabilities.prepareBoundInTransaction(
			db,
			owner,
			"package:browser.operate@2",
			"tool:browser.task.start@2",
			{ request: "このタブで商品名を検索して" },
		),
	);
	expect(prepared.dependencies.map((d) => d.revisionId)).toContain(
		"package:browser.page-operator@2",
	);
	// The operator is fixed on its own too: the exact revision the runner prepares.
	const operator = s.store.read((db) =>
		s.capabilities.prepareActiveByIdInTransaction(
			db,
			owner,
			"package:browser.page-operator@2",
			{ request: "x" },
		),
	);
	expect(operator.package.toolRevisionIds).toHaveLength(14);
});

test("every tool the operator package offers has a flat schema the host also checks", async () => {
	const s = await setup();
	const owner = { rootRunId: "run-1", taskId: "task-1", cancelEpoch: 0 };
	const operator = s.store.read((db) =>
		s.capabilities.prepareActiveByIdInTransaction(
			db,
			owner,
			"package:browser.page-operator@2",
			{ request: "x" },
		),
	);
	const tools = operator.dependencies.filter((d) => d.kind === "tool");
	expect(tools.map((t) => t.id)).toEqual(
		(operator.package.toolRevisionIds ?? []).map((id) =>
			id.slice("tool:".length, id.lastIndexOf("@")),
		),
	);
	for (const tool of tools) {
		const schema = z.toJSONSchema(validators[tool.schemaKey!]) as {
			type: string;
			additionalProperties: boolean;
		};
		expect(schema.type).toBe("object");
		expect(schema.additionalProperties).toBe(false);
	}
});
