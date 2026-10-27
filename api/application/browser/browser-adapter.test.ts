import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { validators } from "../../domains/capabilities";
import {
	connect,
	fakeBrave,
	parkedRunner,
	runCleanup,
	setup as setupDomain,
	until,
	WEB,
} from "../../domains/browser/test/fakes";
import { CONVERSATION_DEFAULT_PRINCIPAL } from "../../domains/conversation/contracts";
import type { AdapterOrigin } from "../../domains/tool-runtime";
import {
	BROWSER_ADAPTER_REF,
	createBrowserAdapter,
	describeBrowserAdapter,
} from "./browser-adapter";
import { EFFECT_MAX_AGE_MS, registerBrowserEffects } from "./browser-effects";

afterEach(runCleanup);

const conversation: AdapterOrigin = {
	kind: "conversation",
	owner: { rootRunId: "run-1", taskId: "task-1", cancelEpoch: 0 },
	runId: "run-1",
	conversationId: "c1",
	messageId: "m1",
};
const ui: AdapterOrigin = { kind: "ui", scope: "main", actionRequestId: "a1" };

/** The user's messages by id, as the conversation would hold them. */
const said = new Map<string, string>();
const requests = {
	userMessageInTransaction: (_db: unknown, id: string) => said.get(id) ?? null,
};

function setup(options: Parameters<typeof setupDomain>[0] = {}) {
	said.clear();
	const env = setupDomain(options);
	const effects = registerBrowserEffects({
		queue: env.queue,
		service: env.service,
	});
	const adapter = createBrowserAdapter(env.service, effects, requests as never);
	const invoke = (
		operationName: string,
		input: unknown,
		origin: AdapterOrigin = conversation,
		requestId: string = crypto.randomUUID(),
		issuedAt: string = new Date().toISOString(),
	) =>
		env.store.write((db) =>
			adapter.invokeInTransaction(db, {
				operationName,
				input,
				requestId,
				issuedAt,
				origin,
			}),
		);
	const snapshot = () =>
		env.store.read(
			(db) =>
				adapter.snapshotInTransaction(db) as {
					connection: { state: string; configured: boolean };
					tabs: Array<{
						tabRef: string;
						place: string;
						title: string;
						active: boolean;
					}>;
					captures: Array<{ captureId: string; state: string }>;
					tasks: Array<{
						taskId: string;
						state: string;
						request: string;
					}>;
				},
		);
	return { env, adapter, invoke, snapshot };
}
type Setup = ReturnType<typeof setup>;

const connected = (s: Setup) => connect(s.env);

test("the adapter registers the operations of the capture toolchain and the screen", () => {
	const description = describeBrowserAdapter();
	expect(BROWSER_ADAPTER_REF).toBe("adapter:browser@1");
	expect(
		Object.fromEntries(
			[...description.operations].map(([k, v]) => [
				k,
				`${v.effect} ${v.inputSchemaRef}`,
			]),
		),
	).toEqual({
		"browser.workspace.open": "read builtin:emptyInput",
		"browser.connect": "write builtin:emptyInput",
		"browser.disconnect": "write builtin:emptyInput",
		"browser.capture.start": "write builtin:browserCaptureStart",
		"browser.capture.status": "read builtin:browserCaptureTarget",
		"browser.capture.cancel": "write builtin:browserCaptureTarget",
		"browser.tab.open": "write builtin:browserTabOpen",
		"browser.tab.focus": "write builtin:browserTabTarget",
		"browser.tab.close": "write builtin:browserTabTarget",
		"browser.task.start": "write builtin:browserTaskStart",
		"browser.task.begin": "write builtin:browserTaskBegin",
		"browser.task.scripted": "write builtin:browserTaskBegin",
		"browser.task.status": "read builtin:browserTaskTarget",
		"browser.task.cancel": "write builtin:browserTaskTarget",
		"browser.history.delete": "write builtin:browserHistoryDelete",
	});
	expect([...description.projections]).toEqual([
		"projection:browser.capture-result@1",
		"projection:browser.task-result@1",
	]);
	expect(description.queries.has("query:browser.workspace@1")).toBe(true);
	expect(description.availability).toBe("availability:browser@1");
});

test("the screen stays reachable while the browser is not connected", () => {
	const s = setup();
	expect(s.env.store.read((db) => s.adapter.availableInTransaction(db))).toBe(
		true,
	);
	expect(s.snapshot().connection).toMatchObject({
		state: "disconnected",
		configured: false,
	});
});

test("connect refuses without a saved path, then starts once and is idempotent", async () => {
	const s = setup();
	await expect(s.invoke("browser.connect", {})).rejects.toThrow(
		"browser_not_configured",
	);
	await s.env.service.setting.save(fakeBrave(s.env.dir));
	const first = await s.invoke("browser.connect", {}, ui);
	expect(first.receipt).toEqual({ action: "connect" });
	await until(() => s.env.service.connection().state === "connected");
	expect(s.env.driver.connectCount).toBe(1);
	// Already connected: accepted, and nothing is started again.
	const again = await s.invoke("browser.connect", {}, ui);
	expect(again.receipt).toEqual({ action: "connect" });
	await Bun.sleep(40);
	expect(s.env.driver.connectCount).toBe(1);
});

test("the snapshot shows tabs the conversation may name, without queries or fragments", async () => {
	const s = setup();
	const tabRef = await connected(s);
	s.env.driver.tabs.push({
		index: 1,
		url: "https://example.com/path?token=secret#frag",
		title: "Example",
		current: false,
	});
	await s.env.service.refreshTabs();
	const shown = s.snapshot();
	expect(shown.connection.state).toBe("connected");
	expect(shown.tabs.map((t) => t.place).sort()).toEqual([
		`${WEB}/`,
		"https://example.com/path",
	]);
	expect(JSON.stringify(shown)).not.toContain("secret");
	expect(shown.tabs.find((t) => t.tabRef === tabRef)?.active).toBe(true);
});

test("a conversation may capture only a tab its snapshot showed; the screen may name any open tab", async () => {
	const s = setup();
	await connected(s);
	for (let i = 1; i < 25; i += 1)
		s.env.driver.tabs.push({
			index: i,
			url: `https://example.com/${i}`,
			title: `tab ${i}`,
			current: false,
		});
	await s.env.service.refreshTabs();
	const shown = new Set(s.snapshot().tabs.map((t) => t.tabRef));
	expect(shown.size).toBe(20);
	const hidden = s.env.service.tabs().find((t) => !shown.has(t.tabRef))!;
	await expect(
		s.invoke("browser.capture.start", {
			tabRef: hidden.tabRef,
			range: "viewport",
		}),
	).rejects.toThrow("browser_tab_not_found");
	await expect(
		s.invoke("browser.capture.start", {
			tabRef: crypto.randomUUID(),
			range: "viewport",
		}),
	).rejects.toThrow("browser_tab_not_found");
	const saved = await s.invoke(
		"browser.capture.start",
		{ tabRef: hidden.tabRef, range: "viewport" },
		ui,
	);
	expect((saved.receipt as { action: string }).action).toBe("capture.start");
});

test("a capture started from the conversation runs, is announced, and its receipt reads back", async () => {
	const s = setup();
	const tabRef = await connected(s);
	const saved = await s.invoke("browser.capture.start", {
		tabRef,
		range: "full-page",
	});
	const captureId = (saved.receipt as { captureId: string }).captureId;
	await until(
		() =>
			s.env.service.captureStatus(CONVERSATION_DEFAULT_PRINCIPAL, captureId)
				.state === "local_ready",
	);
	expect(s.env.notices.map((n) => n.conversationId)).toEqual(["c1"]);
	const read = s.env.store.read((db) =>
		s.adapter.readInTransaction(db, saved.receiptRef.operationId),
	);
	// The receipt body is identifiers only, so it reads back unchanged after the state moved on.
	expect(read?.receiptRef.digest).toBe(saved.receiptRef.digest);
	expect(read?.receipt).toEqual(saved.receipt);
	expect(
		s.env.store.read((db) =>
			s.adapter.readInTransaction(db, "capture.start:x"),
		),
	).toBeNull();
	// The captured id is now in the snapshot, so status and cancel may name it.
	expect(s.snapshot().captures.map((c) => c.captureId)).toContain(captureId);
	const status = await s.invoke("browser.capture.status", { captureId });
	expect(status.receipt).toEqual({ action: "capture.status", captureId });
	await expect(
		s.invoke("browser.capture.status", { captureId: crypto.randomUUID() }),
	).rejects.toThrow("browser_capture_not_found");
});

test("a capture of an unknown tab is refused even from the screen", async () => {
	const s = setup();
	await expect(
		s.invoke(
			"browser.capture.start",
			{ tabRef: crypto.randomUUID(), range: "viewport" },
			ui,
		),
	).rejects.toThrow("browser_tab_not_found");
});

test("cancelling a capture ends it and aborts the stage in flight after the commit", async () => {
	const s = setup();
	const tabRef = await connected(s);
	let release!: () => void;
	s.env.driver.screenshotGate = new Promise((resolve) => {
		release = resolve;
	});
	const saved = await s.invoke(
		"browser.capture.start",
		{ tabRef, range: "viewport" },
		ui,
	);
	const captureId = (saved.receipt as { captureId: string }).captureId;
	await until(() => s.env.driver.calls.includes("screenshot"));
	const cancelled = await s.invoke("browser.capture.cancel", { captureId }, ui);
	expect(cancelled.receipt).toEqual({ action: "capture.cancel", captureId });
	expect(
		s.env.service.captureStatus(CONVERSATION_DEFAULT_PRINCIPAL, captureId)
			.state,
	).toBe("cancelled");
	release();
	await Bun.sleep(60);
	expect(
		s.env.service.captureStatus(CONVERSATION_DEFAULT_PRINCIPAL, captureId)
			.state,
	).toBe("cancelled");
	expect(s.env.files.final.size).toBe(0);
});

test("screen tab operations queue the browser call and refuse tabs that are not listed", async () => {
	const s = setup();
	const tabRef = await connected(s);
	await s.invoke("browser.tab.open", { url: "https://example.com/" }, ui);
	await until(() => s.env.driver.calls.some((c) => c.startsWith("newTab:")));
	await s.env.service.refreshTabs();
	const opened = s.env.service.tabs().find((t) => t.title === "new")!;
	expect(opened.active).toBe(true);
	const focus = await s.invoke("browser.tab.focus", { tabRef }, ui);
	expect(focus.receipt).toEqual({ action: "tab.focus", tabRef });
	await until(() => s.env.driver.calls.includes("selectTab:0"));
	await s.invoke("browser.tab.close", { tabRef: opened.tabRef }, ui);
	await until(() => s.env.driver.calls.some((c) => c.startsWith("closeTab:")));
	await expect(
		s.invoke("browser.tab.focus", { tabRef: crypto.randomUUID() }, ui),
	).rejects.toThrow("browser_tab_not_found");
});

test("a tab cannot be opened while the browser is not connected", async () => {
	const s = setup();
	await expect(
		s.invoke("browser.tab.open", { url: "https://example.com/" }, ui),
	).rejects.toThrow("browser_disconnected");
});

test("disconnect stops the connection; opening the workspace changes nothing", async () => {
	const s = setup();
	await connected(s);
	const open = await s.invoke("browser.workspace.open", {});
	expect(open.receipt).toEqual({ action: "open" });
	await s.invoke("browser.disconnect", {}, ui);
	await until(() => s.env.service.connection().state === "disconnected");
	expect(s.env.service.connection().endReason).toBe("user");
});

test("a replay of the same request repeats its receipt and queues no second effect", async () => {
	const s = setup();
	await s.env.service.setting.save(fakeBrave(s.env.dir));
	const requestId = crypto.randomUUID();
	const issuedAt = new Date().toISOString();
	const a = await s.invoke("browser.connect", {}, ui, requestId, issuedAt);
	// Even with another stamp the replay is the same job, not a conflict.
	const b = await s.invoke("browser.connect", {}, ui, requestId);
	expect(b.receiptRef).toEqual(a.receiptRef);
	await until(() => s.env.service.connection().state === "connected");
	expect(s.env.driver.connectCount).toBe(1);
});

test("an effect that waited past its age expires unrun instead of running late", async () => {
	const s = setup();
	await s.env.service.setting.save(fakeBrave(s.env.dir));
	const issued = new Date(Date.now() - EFFECT_MAX_AGE_MS - 1_000).toISOString();
	await s.invoke("browser.connect", {}, ui, crypto.randomUUID(), issued);
	await Bun.sleep(80);
	expect(s.env.driver.connectCount).toBe(0);
	expect(s.env.service.connection().state).toBe("disconnected");
});

test("the workspace source reads the domain's data and nothing else", () => {
	const s = setup();
	const read = s.env.store.read((db) =>
		s.adapter.sourceInTransaction(db, "query:browser.workspace@1", undefined),
	);
	expect(Object.keys((read as { data: object }).data).sort()).toEqual([
		"availability",
		"captures",
		"connection",
		"tabs",
		"tasks",
	]);
	expect(
		s.env.store.read((db) =>
			s.adapter.sourceInTransaction(db, "query:browser.other@1", undefined),
		),
	).toBeNull();
	expect(
		s.env.store.read((db) =>
			s.adapter.sourceInTransaction(db, "query:browser.workspace@1", "x"),
		),
	).toBeNull();
});

const asked = "このタブで「ワイヤレスイヤホン」を探して";
const task = (saved: { receipt: unknown }) =>
	(saved.receipt as { taskId: string }).taskId;

test("a task keeps the user's own words as its request and the command step's paraphrase beside it", async () => {
	const s = setup({ runTaskStep: parkedRunner });
	const tabRef = await connected(s);
	said.set("m1", asked);
	const requestId = crypto.randomUUID();
	const saved = await s.invoke(
		"browser.task.start",
		{ request: "ワイヤレスイヤホンを検索する", tabRef },
		conversation,
		requestId,
	);
	expect(saved.receipt).toMatchObject({ action: "task.start" });
	expect(saved.answerContext).toMatchObject({
		kind: "browser",
		result: expect.stringContaining('"accepted":true'),
	});
	const row = s.env.service.taskRow(task(saved))!;
	expect(row).toMatchObject({
		request: asked,
		tab_ref: tabRef,
		origin: "conversation",
		conversation_id: "c1",
	});
	expect(JSON.parse(row.frozen_json!)).toEqual({
		brief: "ワイヤレスイヤホンを検索する",
	});
	expect(JSON.parse(row.core_state_json ?? "null")).toBeNull();
	// The same request id repeats its receipt and starts no second task.
	const again = await s.invoke(
		"browser.task.start",
		{ request: "ワイヤレスイヤホンを検索する", tabRef },
		conversation,
		requestId,
	);
	expect(task(again)).toBe(task(saved));
	expect(s.env.service.listTasks(CONVERSATION_DEFAULT_PRINCIPAL)).toHaveLength(
		1,
	);
});

test("a task that stopped for the user's approval is shown with what it waits for, and its approval reaches the task that continues it", async () => {
	const held: unknown[] = [];
	const s = setup({
		runTaskStep: async (input, { api }) => {
			if (input.request === "送って")
				return {
					kind: "done",
					state: "needs_input",
					coreState: { ended: true },
					text: "http://localhost:5173で「送信」をクリックします。確認が要るため止めました。",
					approvals: [
						{
							kind: "operation",
							tabRef: input.tabRef!,
							url: `${WEB}/`,
							action: "click",
							element: "送信",
							summary: "「送信」をクリックします",
						},
					],
				};
			held.push(api.approvals());
			return {
				kind: "done",
				state: "completed",
				coreState: {},
				text: "送りました。",
			};
		},
	});
	const tabRef = await connected(s);
	said.set("m1", "送って");
	const first = await s.invoke("browser.task.begin", {
		request: "送る",
		tabRef,
	});
	await until(
		() => s.env.service.taskRow(task(first))!.state === "needs_input",
	);
	// The snapshot tells the conversation what the stopped task said it was waiting for.
	const shown = s.snapshot().tasks.find((t) => t.taskId === task(first)) as {
		waitingFor?: string;
	};
	expect(shown.waitingFor).toContain("「送信」をクリックします");

	// The conversation can continue only a task its snapshot showed, and tells the tab only by default.
	await expect(
		s.invoke("browser.task.begin", {
			request: "はい",
			continueFrom: crypto.randomUUID(),
			approvePending: true,
		}),
	).rejects.toThrow("browser_task_not_found");
	said.set("m1", "はい、送って");
	const next = await s.invoke("browser.task.begin", {
		request: "送信ボタンを押す",
		continueFrom: task(first),
		approvePending: true,
	});
	await until(() => s.env.service.taskRow(task(next))!.state === "completed");
	expect(s.env.service.taskRow(task(next))!.tab_ref).toBe(tabRef);
	expect(held).toEqual([
		[
			expect.objectContaining({
				kind: "operation",
				action: "click",
				element: "送信",
			}),
		],
	]);

	// Asking to continue without approving moves nothing.
	said.set("m1", "やっぱり");
	const again = await s.invoke("browser.task.begin", {
		request: "やっぱり",
		continueFrom: task(first),
	});
	await until(() => s.env.service.taskRow(task(again))!.state === "completed");
	expect(held.at(-1)).toEqual([]);
});

test("without a saved user message the paraphrase is the request; the screen's own words are used as given", async () => {
	const s = setup({ runTaskStep: parkedRunner });
	await connected(s);
	const fromConversation = await s.invoke("browser.task.start", {
		request: "設定を開く",
	});
	expect(s.env.service.taskRow(task(fromConversation))).toMatchObject({
		request: "設定を開く",
		frozen_json: "{}",
	});
	said.set("m1", "   ");
	const blank = await s.invoke("browser.task.start", {
		request: "設定を開く2",
	});
	expect(s.env.service.taskRow(task(blank))!.request).toBe("設定を開く2");
	const fromScreen = await s.invoke(
		"browser.task.start",
		{ request: "画面から" },
		ui,
	);
	expect(s.env.service.taskRow(task(fromScreen))).toMatchObject({
		request: "画面から",
		origin: "screen",
		conversation_id: "main",
	});
});

test("a task needs a connection, a tab its snapshot showed, and room", async () => {
	const s = setup({ runTaskStep: parkedRunner });
	await expect(
		s.invoke("browser.task.start", { request: "開く" }),
	).rejects.toThrow("browser_disconnected");
	await connected(s);
	await expect(
		s.invoke("browser.task.start", {
			request: "開く",
			tabRef: crypto.randomUUID(),
		}),
	).rejects.toThrow("browser_tab_not_found");
	const bare = setup();
	await connect(bare.env);
	await expect(
		bare.invoke("browser.task.start", { request: "開く" }),
	).rejects.toThrow("browser_task_runner_missing");
});

test("status reads a task the snapshot showed, cancel ends it and aborts the running step after the commit", async () => {
	let aborted = false;
	const s = setup({
		runTaskStep: async (_step, { signal }) => {
			await new Promise<void>((resolve) =>
				signal.addEventListener("abort", () => resolve()),
			);
			aborted = true;
			return { kind: "continue", coreState: {} };
		},
	});
	await connected(s);
	const started = await s.invoke("browser.task.start", { request: "開く" });
	const taskId = task(started);
	await until(() => s.env.service.taskRow(taskId)!.state === "running");
	expect(s.snapshot().tasks).toEqual([
		{ taskId, state: "running", request: "開く" },
	]);
	expect((await s.invoke("browser.task.status", { taskId })).receipt).toEqual({
		action: "task.status",
		taskId,
	});
	await expect(
		s.invoke("browser.task.status", { taskId: crypto.randomUUID() }),
	).rejects.toThrow("browser_task_not_found");
	const cancelled = await s.invoke("browser.task.cancel", { taskId });
	expect(cancelled.answerContext).toMatchObject({
		result: expect.stringContaining('"state":"cancelled"'),
	});
	expect(s.env.service.taskRow(taskId)!.state).toBe("cancelled");
	await until(() => aborted);
	// A finished task reads back from its operation id.
	const back = s.env.store.read((db) =>
		s.adapter.readInTransaction(db, `task.status:${taskId}`),
	);
	expect(back?.receipt).toEqual({ action: "task.status", taskId });
	expect(
		s.env.store.read((db) =>
			s.adapter.readInTransaction(db, `task.status:${crypto.randomUUID()}`),
		),
	).toBeNull();
});

const bundle = JSON.parse(
	readFileSync(
		new URL(
			"../../domains/capabilities/bundles/browser.bundle.json",
			import.meta.url,
		),
		"utf8",
	),
) as {
	definitions: Array<{
		kind: string;
		id: string;
		revision: number;
		schemaKey?: string;
	}>;
	bindings: Array<{
		id: string;
		revision: number;
		adapterRef: string;
		artifactRevisionId: string;
		tools: Array<{
			toolRevisionId: string;
			operationId: string;
			inputSchemaRef: string;
		}>;
	}>;
	artifacts: Array<{
		revision: number;
		sourceBindings: Array<{ adapterRef: string; query: string }>;
		actionBindings: Array<{
			actionId: string;
			eventAction: string;
			source: string;
			operationId?: string;
			inputSchemaRef: string;
			inputAdapterRef?: string;
			effect: string;
		}>;
	}>;
};

test("each binding of the bundle names only operations, schemas and queries this adapter registers", () => {
	const { operations, queries } = describeBrowserAdapter();
	expect(bundle.bindings.map((b) => `${b.id}@${b.revision}`)).toEqual([
		"browser.capture@1",
		"browser.capture@2",
		"browser.capture@3",
		"browser.operate@1",
		"browser.operate@2",
		"browser.operate@3",
		"browser.operate@4",
		"browser.capture@4",
		"browser.operate@5",
		"browser.capture@5",
	]);
	const binding = (id: string, revision: number) =>
		bundle.bindings.find((b) => b.id === id && b.revision === revision)!;
	const operationsOf = (id: string, revision: number) =>
		binding(id, revision)
			.tools.map((t) => t.operationId)
			.sort();
	for (const binding of bundle.bindings) {
		expect(binding.adapterRef).toBe(BROWSER_ADAPTER_REF);
		for (const tool of binding.tools) {
			expect(operations.get(tool.operationId)?.inputSchemaRef).toBe(
				tool.inputSchemaRef,
			);
			// The tool's own schema key is the one its binding names.
			const key = bundle.definitions.find(
				(d) =>
					d.kind === "tool" &&
					`tool:${d.id}@${d.revision}` === tool.toolRevisionId,
			)?.schemaKey;
			expect(`builtin:${key}`).toBe(tool.inputSchemaRef);
			expect(Object.hasOwn(validators, key!)).toBe(true);
		}
	}
	// The capture toolchain offers the capture operations plus connecting and opening the screen.
	expect(operationsOf("browser.capture", 1)).toEqual([
		"browser.capture.cancel",
		"browser.capture.start",
		"browser.capture.status",
		"browser.connect",
		"browser.workspace.open",
	]);
	// The operate toolchain offers the task operations plus connecting and opening the screen.
	expect(operationsOf("browser.operate", 1)).toEqual([
		"browser.connect",
		"browser.task.cancel",
		"browser.task.start",
		"browser.task.status",
		"browser.workspace.open",
	]);
	// Revision 2 of it starts tasks with the schema that can continue after an approval; the rest is as it was.
	expect(operationsOf("browser.operate", 2)).toEqual([
		"browser.connect",
		"browser.task.begin",
		"browser.task.cancel",
		"browser.task.status",
		"browser.workspace.open",
	]);
	// Later revisions only move both toolchains onto the newest screen, so the launcher lists it once.
	for (const [id, revision] of [
		["browser.capture", 2],
		["browser.capture", 3],
		["browser.operate", 3],
		["browser.operate", 5],
		["browser.capture", 5],
	] as const) {
		expect(operationsOf(id, revision)).toEqual(operationsOf(id, revision - 1));
		expect(binding(id, revision).artifactRevisionId).toBe(
			`artifact:browser.workspace@${revision}`,
		);
	}
	expect(bundle.artifacts.map((a) => a.revision)).toEqual([1, 2, 3, 4, 5, 1]);
	for (const artifact of bundle.artifacts) {
		for (const source of artifact.sourceBindings) {
			expect(source.adapterRef).toBe(BROWSER_ADAPTER_REF);
			expect(queries.has(source.query)).toBe(true);
		}
		for (const action of artifact.actionBindings.filter((a) => a.operationId)) {
			const operation = operations.get(action.operationId!);
			expect(operation?.inputSchemaRef).toBe(action.inputSchemaRef);
			expect(operation?.effect as string).toBe(action.effect);
		}
	}
	// Revision 2 adds the cancel-task action to revision 1's and keeps the rest.
	const [first, second] = bundle.artifacts;
	const ids = (a: typeof first) => a!.actionBindings.map((x) => x.actionId);
	expect(ids(second)).toEqual(
		ids(first).flatMap((id) =>
			id === "cancel-capture" ? [id, "cancel-task"] : [id],
		),
	);
	expect(
		second!.actionBindings.find((a) => a.actionId === "cancel-task"),
	).toMatchObject({
		eventAction: "browser-cancel-task",
		operationId: "browser.task.cancel",
		inputSchemaRef: "builtin:browserTaskTarget",
		effect: "write",
	});
	// Revision 3 adds choosing the Brave file in the OS dialog before saving the path.
	const third = bundle.artifacts[2];
	expect(ids(third)).toEqual(
		ids(second).flatMap((id) =>
			id === "save-path" ? ["browse-path", id] : [id],
		),
	);
	expect(
		third!.actionBindings.find((a) => a.actionId === "browse-path"),
	).toEqual({
		actionId: "browse-path",
		eventAction: "browser-browse-path",
		source: "browser",
		inputSchemaRef: "builtin:emptyInput",
		effect: "local",
	});
	// Revision 5 adds the history delete, whose string event values the input adapter converts.
	const fifth = bundle.artifacts[4];
	expect(
		ids(fifth).filter((id) => !ids(bundle.artifacts[3]).includes(id)),
	).toEqual(["delete-history"]);
	expect(
		fifth!.actionBindings.find((a) => a.actionId === "delete-history"),
	).toEqual({
		actionId: "delete-history",
		eventAction: "browser-delete-history",
		source: "browser",
		operationId: "browser.history.delete",
		inputSchemaRef: "builtin:browserHistoryDelete",
		inputAdapterRef: "input:browser.history-delete@1",
		effect: "write",
	});
});

test("the tool schemas the model sees are flat objects", () => {
	for (const key of ["browserCaptureStart", "browserCaptureTarget"] as const) {
		const schema = z.toJSONSchema(validators[key]) as {
			type: string;
			properties: Record<string, object>;
			additionalProperties: boolean;
		};
		expect(schema.type).toBe("object");
		expect(schema.additionalProperties).toBe(false);
		expect(Object.keys(schema.properties).length).toBeGreaterThan(0);
	}
	// Quality, format and file names are never inputs; an element capture needs an observation.
	expect(
		validators.browserCaptureStart.safeParse({
			tabRef: crypto.randomUUID(),
			range: "element",
		}).success,
	).toBe(false);
	expect(
		validators.browserCaptureStart.safeParse({
			tabRef: crypto.randomUUID(),
			range: "viewport",
			quality: 100,
		}).success,
	).toBe(false);
});

test("the scripted task entry accepts a new disconnected request only with saved connection authorization", async () => {
	const s = setup({ runTaskStep: parkedRunner, canAutoConnect: () => true });
	await s.env.service.setting.save(fakeBrave(s.env.dir));
	const out = await s.invoke("browser.task.scripted", {
		request: "ページを確認して",
	});
	expect(out).toMatchObject({ receipt: { action: "task.start" } });
	const row = s.env.store.read((db) =>
		db.query("SELECT script_required FROM browser_tasks").get(),
	);
	expect(row).toEqual({ script_required: 1 });
	expect(s.env.driver.connectCount).toBe(0);
	const manual = setup({ runTaskStep: parkedRunner });
	await manual.env.service.setting.save(fakeBrave(manual.env.dir));
	await expect(
		manual.invoke("browser.task.scripted", { request: "ページを確認して" }),
	).rejects.toThrow("browser_disconnected");
});

const HISTORY_ID = "7c0e3b1a-5d2f-4a6b-9c81-0e4f6a2b3c4d";
const seedHistory = (s: Setup, owner = CONVERSATION_DEFAULT_PRINCIPAL) =>
	s.env.store.write((db) =>
		db
			.query(
				`INSERT INTO browser_histories(id,owner,title,request,place,variables_json,steps_json,actions_json,
				 revision,run_count,failure_count,last_outcome,has_commit,last_used_at,created_at,updated_at)
				 VALUES(?,?,'手順','依頼','example.com','[]','[]','[]',3,1,0,'completed',0,1,1,1)`,
			)
			.run(HISTORY_ID, owner),
	);
const historyCount = (s: Setup) =>
	s.env.store.read(
		(db) =>
			(
				db.query("SELECT COUNT(*) AS n FROM browser_histories").get() as {
					n: number;
				}
			).n,
	);

test("deleting a history is the screen's: it needs the revision the screen showed, and the conversation cannot do it", async () => {
	const s = setup();
	await seedHistory(s);
	const input = { historyId: HISTORY_ID, expectedRevision: 3 };
	await expect(s.invoke("browser.history.delete", input)).rejects.toThrow(
		"origin_invalid",
	);
	await expect(
		s.invoke("browser.history.delete", { ...input, expectedRevision: 2 }, ui),
	).rejects.toThrow("browser_history_conflict");
	await expect(
		s.invoke(
			"browser.history.delete",
			{ ...input, historyId: crypto.randomUUID() },
			ui,
		),
	).rejects.toThrow("browser_history_not_found");
	expect(historyCount(s)).toBe(1);
	const out = await s.invoke("browser.history.delete", input, ui);
	expect(out.receipt).toEqual({
		action: "history.delete",
		historyId: HISTORY_ID,
	});
	expect(historyCount(s)).toBe(0);
	// The receipt reads back by its operation id.
	const back = s.env.store.read((db) =>
		s.adapter.readInTransaction(db, `history.delete:${HISTORY_ID}`),
	);
	expect(back?.receipt).toEqual({
		action: "history.delete",
		historyId: HISTORY_ID,
	});
});

test("the delete event's string revision becomes a number; anything else reports every field", () => {
	const convert = describeBrowserAdapter().inputAdapters.get(
		"input:browser.history-delete@1",
	)!;
	expect(convert({ historyId: HISTORY_ID, expectedRevision: "12" })).toEqual({
		ok: true,
		value: { historyId: HISTORY_ID, expectedRevision: 12 },
	});
	expect(convert({ historyId: HISTORY_ID, expectedRevision: "0" })).toEqual({
		ok: true,
		value: { historyId: HISTORY_ID, expectedRevision: 0 },
	});
	for (const bad of ["abc", "-1", "1.5", "", "12345678901"])
		expect(convert({ historyId: HISTORY_ID, expectedRevision: bad })).toEqual({
			ok: false,
			errors: [
				{ field: "expectedRevision", message: "revision を確認してください" },
			],
		});
	expect(convert({ historyId: HISTORY_ID, expectedRevision: 3 })).toMatchObject(
		{
			ok: false,
		},
	);
	expect(convert({ expectedRevision: "3" })).toEqual({
		ok: false,
		errors: [{ field: "historyId", message: "履歴を指定してください" }],
	});
	expect(convert({})).toMatchObject({
		ok: false,
		errors: [{ field: "historyId" }, { field: "expectedRevision" }],
	});
});
