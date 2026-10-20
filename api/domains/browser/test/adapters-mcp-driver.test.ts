import { afterEach, expect, test } from "bun:test";
import {
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	BrowserDriver,
	DriverAction,
	DriverConnectionState,
} from "../contracts/ports";
import { BrowserDriverError } from "../contracts/ports";
import {
	ALLOWED_MCP_TOOLS,
	createMcpBrowserDriver,
} from "../adapters/mcp-driver";

const FAKE = join(import.meta.dir, "fixtures", "adapters-fake-mcp.ts");
const NEVER = new AbortController().signal;
const CLICK_NEVER_PERFORMED = `Error: locator.click: Timeout 5000ms exceeded.
Call log:
  - waiting for locator('aria-ref=e9')
  -   locator resolved to <button disabled>Send</button>
  - attempting click action
  -   waiting for element to be visible, enabled and stable
  -   element is not enabled
  -   retrying click action
  -     waiting 20ms`;
const NAME_NOT_RESOLVED = `Error: page.goto: net::ERR_NAME_NOT_RESOLVED at https://x.test/
Call log:
  - navigating to "https://x.test/", waiting until "domcontentloaded"`;

type Call = { kind: string; name?: string; args?: Record<string, unknown> };
const roots: string[] = [];
const drivers: BrowserDriver[] = [];

function setup(
	config: Record<string, unknown> = {},
	options: {
		extensionToken?: string;
		connectTimeoutMs?: number;
		callTimeoutMs?: number;
		executablePath?: string;
	} = {},
) {
	const root = mkdtempSync(join(tmpdir(), "eumenes-browser-adapters-"));
	roots.push(root);
	const outputDir = join(root, "out");
	const setConfig = (next: Record<string, unknown>) =>
		writeFileSync(join(root, "fake-config.json"), JSON.stringify(next));
	setConfig(config);
	const driver = createMcpBrowserDriver({
		executablePath: options.executablePath ?? "/fake/brave",
		extensionToken: options.extensionToken,
		outputDir,
		connectTimeoutMs: options.connectTimeoutMs ?? 10_000,
		callTimeoutMs: options.callTimeoutMs ?? 10_000,
		launch: { command: process.execPath, args: [FAKE] },
	});
	drivers.push(driver);
	const log = (): Call[] => {
		try {
			return readFileSync(join(root, "fake-calls.jsonl"), "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
		} catch {
			return [];
		}
	};
	return {
		driver,
		outputDir,
		setConfig,
		log,
		calls: () => log().filter((entry) => entry.kind === "call"),
		start: () =>
			log().find((entry) => entry.kind === "start") as unknown as {
				pid: number;
				argv: string[];
				envKeys: string[];
				executablePath: string;
				cwd: string;
			},
	};
}

async function connected(config: Record<string, unknown> = {}) {
	const ctx = setup(config);
	expect((await ctx.driver.connect(NEVER)).state).toBe("connected");
	return ctx;
}

const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

afterEach(async () => {
	for (const driver of drivers.splice(0)) await driver.disconnect();
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

test("connect starts the pinned child with only three env vars and a managed output dir", async () => {
	const ctx = setup();
	const states: DriverConnectionState[] = [];
	ctx.driver.onStateChange((state) => states.push(state));
	const result = await ctx.driver.connect(NEVER);
	expect(result.state).toBe("connected");
	expect(states.map((s) => s.state)).toEqual(["connecting", "connected"]);
	const start = ctx.start();
	expect(start.envKeys).toEqual(
		["HOME", "PATH", "PLAYWRIGHT_MCP_EXECUTABLE_PATH"].sort(),
	);
	expect(start.executablePath).toBe("/fake/brave");
	expect(start.argv).toEqual([
		"--extension",
		"--output-dir",
		ctx.outputDir,
		"--no-webmcp",
	]);
	expect(realpathSync(start.cwd)).toBe(realpathSync(ctx.outputDir));
	// The first tool call is the one that opens Brave's connect page.
	expect(ctx.calls()[0]).toMatchObject({
		name: "browser_tabs",
		args: { action: "list" },
	});
});

test("without a saved executable the driver is not configured and starts nothing", async () => {
	const ctx = setup({}, { executablePath: "" });
	expect(await ctx.driver.connect(NEVER)).toEqual({
		state: "disconnected",
		reason: "not_configured",
	});
	expect(ctx.log()).toEqual([]);
});

test("connect waits for the user and ends as connect_timeout, stopping the child", async () => {
	const ctx = setup({ connectDelayMs: 5000 }, { connectTimeoutMs: 400 });
	const result = await ctx.driver.connect(NEVER);
	expect(result).toEqual({ state: "disconnected", reason: "connect_timeout" });
	const pid = ctx.start().pid;
	await Bun.sleep(100);
	expect(alive(pid)).toBe(false);
	await expect(ctx.driver.listTabs()).rejects.toMatchObject({
		code: "not_connected",
	});
});

test("aborting the connect signal ends as user; a failing connect page ends as mcp_unavailable", async () => {
	const aborting = setup({ connectDelayMs: 5000 });
	const controller = new AbortController();
	const pending = aborting.driver.connect(controller.signal);
	await Bun.sleep(300);
	controller.abort();
	expect(await pending).toEqual({ state: "disconnected", reason: "user" });

	const failing = setup({ connectError: "Extension connection rejected" });
	expect(await failing.driver.connect(NEVER)).toEqual({
		state: "disconnected",
		reason: "mcp_unavailable",
	});
});

test("a child that exits mid-session reports process_exited and fails the call honestly", async () => {
	const ctx = await connected();
	const states: DriverConnectionState[] = [];
	ctx.driver.onStateChange((state) => states.push(state));
	ctx.setConfig({ exitOnCall: "browser_snapshot" });
	await expect(ctx.driver.snapshot(NEVER)).rejects.toMatchObject({
		code: "process_exited",
		dispatched: true,
	});
	expect(ctx.driver.state()).toEqual({
		state: "disconnected",
		reason: "process_exited",
	});
	expect(states).toEqual([{ state: "disconnected", reason: "process_exited" }]);
});

test("an action that dies with the child is reported as dispatched", async () => {
	const ctx = await connected();
	ctx.setConfig({ exitOnCall: "browser_click" });
	expect(
		await ctx.driver.act(
			{ kind: "click", ref: "e4", element: "button" },
			NEVER,
		),
	).toEqual({ ok: false, code: "process_exited", dispatched: true });
});

test("a closed browser reported by MCP ends the session as browser_closed", async () => {
	const ctx = await connected();
	ctx.setConfig({
		errors: {
			browser_snapshot: "Target page, context or browser has been closed",
		},
	});
	await expect(ctx.driver.snapshot(NEVER)).rejects.toMatchObject({
		code: "browser_closed",
	});
	await Bun.sleep(100);
	expect(ctx.driver.state()).toEqual({
		state: "disconnected",
		reason: "browser_closed",
	});
	expect(alive(ctx.start().pid)).toBe(false);
});

test("disconnect stops the child, reports user and leaves nothing in the output dir", async () => {
	const ctx = await connected();
	await ctx.driver.snapshot(NEVER);
	await ctx.driver.disconnect();
	expect(ctx.driver.state()).toEqual({ state: "disconnected", reason: "user" });
	expect(alive(ctx.start().pid)).toBe(false);
	expect(readdirSync(ctx.outputDir)).toEqual([]);
});

test("tab operations parse the tab list from the result section", async () => {
	const ctx = await connected();
	expect(await ctx.driver.listTabs()).toEqual([
		{
			index: 0,
			title: "Eumenes",
			url: "http://127.0.0.1:5173/",
			current: true,
		},
	]);
	const afterNew = await ctx.driver.newTab("https://example.com/?from=mcp");
	expect(afterNew).toEqual([
		{
			index: 0,
			title: "Eumenes",
			url: "http://127.0.0.1:5173/",
			current: false,
		},
		{
			index: 1,
			title: "Example Domain",
			url: "https://example.com/?from=mcp",
			current: true,
		},
	]);
	expect((await ctx.driver.selectTab(0))[0]?.current).toBe(true);
	expect(await ctx.driver.closeTab(1)).toHaveLength(1);
	const names = ctx.calls().map((c) => [c.name, c.args]);
	expect(names).toContainEqual([
		"browser_tabs",
		{ action: "new", url: "https://example.com/?from=mcp" },
	]);
	expect(names).toContainEqual([
		"browser_tabs",
		{ action: "select", index: 0 },
	]);
	expect(names).toContainEqual(["browser_tabs", { action: "close", index: 1 }]);
	expect(readdirSync(ctx.outputDir)).toEqual([]);
});

test("a new tab accepts only http(s) and an integer index", async () => {
	const ctx = await connected();
	const before = ctx.calls().length;
	for (const url of [
		"file:///etc/passwd",
		"javascript:alert(1)",
		"chrome://settings",
		"nope",
	])
		await expect(ctx.driver.newTab(url)).rejects.toMatchObject({
			code: "invalid_url",
			dispatched: false,
		});
	await expect(ctx.driver.selectTab(1.5)).rejects.toMatchObject({
		code: "invalid_tab_index",
	});
	expect(ctx.calls().length).toBe(before);
});

test("an inline snapshot is returned whole and MCP's side files are deleted", async () => {
	const ctx = await connected({ snapshotMode: "inline" });
	const snapshot = await ctx.driver.snapshot(NEVER);
	expect(snapshot.url).toBe("http://127.0.0.1:5173/");
	expect(snapshot.title).toBe("Eumenes");
	expect(snapshot.snapshot).toContain(
		'button "アーティファクトを開く" [ref=e4]',
	);
	expect(readdirSync(ctx.outputDir)).toEqual([]);
});

test("a file-linked snapshot is read from the output dir and then deleted", async () => {
	const ctx = await connected({ snapshotMode: "file" });
	const snapshot = await ctx.driver.snapshot(NEVER);
	expect(snapshot.snapshot).toContain("[ref=e3]");
	expect(readdirSync(ctx.outputDir)).toEqual([]);
});

test("actions map to the allowlisted tools with `target` refs and report the resulting page", async () => {
	const ctx = await connected();
	const actions: DriverAction[] = [
		{ kind: "navigate", url: "https://example.com/" },
		{ kind: "back" },
		{ kind: "click", ref: "e4", element: "open" },
		{ kind: "hover", ref: "f1e7", element: "menu" },
		{ kind: "type", ref: "e5", element: "search", text: "abc", submit: true },
		{ kind: "select", ref: "e6", element: "size", values: ["L"] },
		{ kind: "press", key: "Enter" },
		{ kind: "wait", text: "Done", textGone: "Loading", seconds: 2 },
	];
	for (const action of actions) {
		const result = await ctx.driver.act(action, NEVER);
		expect(result.ok).toBe(true);
	}
	const sent = ctx
		.calls()
		.slice(1)
		.map((c) => [c.name, c.args]);
	expect(sent).toEqual([
		["browser_navigate", { url: "https://example.com/" }],
		["browser_navigate_back", {}],
		["browser_click", { target: "e4", element: "open" }],
		["browser_hover", { target: "f1e7", element: "menu" }],
		[
			"browser_type",
			{ target: "e5", element: "search", text: "abc", submit: true },
		],
		["browser_select_option", { target: "e6", element: "size", values: ["L"] }],
		["browser_press_key", { key: "Enter" }],
		["browser_wait_for", { text: "Done", textGone: "Loading", time: 2 }],
	]);
	const navigated = await ctx.driver.act(
		{ kind: "navigate", url: "https://example.org/x" },
		NEVER,
	);
	expect(navigated).toEqual({
		ok: true,
		url: "https://example.org/x",
		title: "Example Domain",
	});
	expect(readdirSync(ctx.outputDir)).toEqual([]);
});

test("refs that are not snapshot refs are refused before anything is sent", async () => {
	const ctx = await connected();
	const before = ctx.calls().length;
	for (const ref of [
		"body > a",
		"text=Delete",
		"e4; x",
		"",
		"E4",
		"e",
		"../e4",
	]) {
		expect(
			await ctx.driver.act({ kind: "click", ref, element: "x" }, NEVER),
		).toEqual({ ok: false, code: "invalid_ref", dispatched: false });
	}
	expect(
		await ctx.driver.act(
			{ kind: "navigate", url: "javascript:alert(1)" },
			NEVER,
		),
	).toEqual({ ok: false, code: "invalid_url", dispatched: false });
	expect(await ctx.driver.act({ kind: "wait" }, NEVER)).toMatchObject({
		ok: false,
		code: "invalid_wait",
		dispatched: false,
	});
	expect(await ctx.driver.act({ kind: "bogus" } as never, NEVER)).toMatchObject(
		{
			ok: false,
			code: "action_not_supported",
			dispatched: false,
		},
	);
	expect(ctx.calls().length).toBe(before);
});

test("tool failures map to honest codes", async () => {
	const ctx = await connected();
	ctx.setConfig({
		errors: {
			browser_click:
				"Ref e9 not found in the current page snapshot. Try capturing new snapshot.",
		},
	});
	expect(
		await ctx.driver.act({ kind: "click", ref: "e9", element: "x" }, NEVER),
	).toEqual({ ok: false, code: "ref_not_found", dispatched: false });
	ctx.setConfig({
		errors: { browser_click: "locator.click: Timeout 5000ms exceeded." },
	});
	expect(
		await ctx.driver.act({ kind: "click", ref: "e9", element: "x" }, NEVER),
	).toEqual({ ok: false, code: "action_timeout", dispatched: true });
	// An actionability wait that ran out before the click was ever performed.
	ctx.setConfig({
		errors: { browser_click: CLICK_NEVER_PERFORMED },
	});
	expect(
		await ctx.driver.act({ kind: "click", ref: "e9", element: "x" }, NEVER),
	).toEqual({ ok: false, code: "action_timeout", dispatched: false });
	ctx.setConfig({ errors: { browser_navigate: NAME_NOT_RESOLVED } });
	expect(
		await ctx.driver.act({ kind: "navigate", url: "https://x.test/" }, NEVER),
	).toEqual({ ok: false, code: "navigation_failed", dispatched: false });
	ctx.setConfig({ errors: { browser_hover: CLICK_NEVER_PERFORMED } });
	expect(
		await ctx.driver.act({ kind: "hover", ref: "e9", element: "x" }, NEVER),
	).toMatchObject({ ok: false, dispatched: false });
	ctx.setConfig({ errors: { browser_click: "something odd" } });
	expect(
		await ctx.driver.act({ kind: "click", ref: "e9", element: "x" }, NEVER),
	).toEqual({ ok: false, code: "mcp_error", dispatched: true });
	expect(ctx.driver.state().state).toBe("connected");
});

test("a hung call times out as dispatched and an abort sends a cancel notification", async () => {
	const ctx = setup({}, { callTimeoutMs: 400 });
	await ctx.driver.connect(NEVER);
	ctx.setConfig({ hangOn: "browser_click" });
	expect(
		await ctx.driver.act({ kind: "click", ref: "e4", element: "x" }, NEVER),
	).toEqual({ ok: false, code: "call_timeout", dispatched: true });

	const slow = setup({}, { callTimeoutMs: 10_000 });
	await slow.driver.connect(NEVER);
	slow.setConfig({ hangOn: "browser_click" });
	const controller = new AbortController();
	const pending = slow.driver.act(
		{ kind: "click", ref: "e4", element: "x" },
		controller.signal,
	);
	await Bun.sleep(300);
	controller.abort();
	expect(await pending).toEqual({
		ok: false,
		code: "cancelled",
		dispatched: true,
	});
	await Bun.sleep(100);
	expect(slow.log().some((entry) => entry.kind === "cancelled")).toBe(true);

	const early = new AbortController();
	early.abort();
	const before = slow.calls().length;
	expect(
		await slow.driver.act({ kind: "press", key: "a" }, early.signal),
	).toEqual({ ok: false, code: "cancelled", dispatched: false });
	expect(slow.calls().length).toBe(before);
});

test("measuring runs only the two fixed functions and rounds up", async () => {
	const ctx = await connected();
	expect(await ctx.driver.measure("viewport")).toEqual({
		width: 1500,
		height: 685,
		devicePixelRatio: 2,
	});
	expect(await ctx.driver.measure("full-page")).toEqual({
		width: 1500,
		height: 2101,
		devicePixelRatio: 2,
	});
	expect(await ctx.driver.measure("element", "e4")).toEqual({
		width: 321,
		height: 80,
		devicePixelRatio: 2,
	});
	const evaluations = ctx.calls().filter((c) => c.name === "browser_evaluate");
	expect(evaluations).toHaveLength(3);
	const functions = new Set(evaluations.map((c) => c.args?.function));
	expect(functions.size).toBe(2);
	for (const fn of functions)
		expect(String(fn)).not.toMatch(/e4|eumenes|http/i);
	expect(evaluations[2]?.args).toMatchObject({ target: "e4" });
	expect(evaluations[0]?.args).not.toHaveProperty("target");
	await expect(ctx.driver.measure("element", "body > a")).rejects.toMatchObject(
		{
			code: "invalid_ref",
		},
	);
	await expect(ctx.driver.measure("element")).rejects.toMatchObject({
		code: "invalid_ref",
	});
});

test("inspection runs one fixed read-only function and validates what it returns", async () => {
	const ctx = await connected({
		targetInfo: {
			tag: "button",
			type: "submit",
			inForm: true,
			formMethod: "post",
			submits: true,
		},
	});
	expect(await ctx.driver.inspectTarget("e4")).toEqual({
		tag: "button",
		type: "submit",
		inForm: true,
		formMethod: "post",
		submits: true,
	});
	expect(await ctx.driver.inspectFocused()).toMatchObject({ submits: true });
	const evaluations = ctx.calls().filter((c) => c.name === "browser_evaluate");
	expect(evaluations).toHaveLength(2);
	expect(evaluations[0]?.args).toMatchObject({ target: "e4" });
	expect(evaluations[1]?.args).not.toHaveProperty("target");
	for (const call of evaluations)
		expect(String(call.args?.function)).not.toMatch(/e4|http|eumenes/i);
	await expect(ctx.driver.inspectTarget("a > b")).rejects.toMatchObject({
		code: "invalid_ref",
		dispatched: false,
	});
	ctx.setConfig({ targetInfo: { tag: "button", inForm: "yes", submits: 1 } });
	await expect(ctx.driver.inspectFocused()).rejects.toMatchObject({
		code: "inspect_invalid",
		dispatched: false,
	});
	ctx.setConfig({ errors: { browser_evaluate: "Error: boom" } });
	await expect(ctx.driver.inspectFocused()).rejects.toMatchObject({
		dispatched: false,
	});
});

test("measuring rejects results that are not positive finite sizes", async () => {
	const ctx = await connected({ evaluateRaw: "undefined" });
	await expect(ctx.driver.measure("viewport")).rejects.toMatchObject({
		code: "measure_invalid",
	});
	ctx.setConfig({
		pageMetrics: {
			viewportWidth: 0,
			viewportHeight: 10,
			scrollWidth: 1,
			scrollHeight: 1,
		},
	});
	await expect(ctx.driver.measure("viewport")).rejects.toMatchObject({
		code: "measure_invalid",
	});
});

test("screenshots come from the image content and ask for CSS-pixel PNG", async () => {
	const ctx = await connected();
	const png = await ctx.driver.screenshot("viewport", undefined, NEVER);
	expect(Array.from(png.slice(0, 8))).toEqual([
		0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
	]);
	await ctx.driver.screenshot("full-page", undefined, NEVER);
	await ctx.driver.screenshot("element", "e4", NEVER);
	const shots = ctx.calls().filter((c) => c.name === "browser_take_screenshot");
	expect(shots.map((c) => c.args)).toEqual([
		{ type: "png", scale: "css" },
		{ type: "png", scale: "css", fullPage: true },
		{ type: "png", scale: "css", target: "e4", element: "captured element" },
	]);
	// The PNG file MCP wrote next to the image content is removed.
	expect(readdirSync(ctx.outputDir)).toEqual([]);
	ctx.setConfig({ images: false });
	await expect(
		ctx.driver.screenshot("viewport", undefined, NEVER),
	).rejects.toMatchObject({
		code: "screenshot_missing",
	});
	await expect(
		ctx.driver.screenshot("element", undefined, NEVER),
	).rejects.toMatchObject({
		code: "invalid_ref",
	});
});

test("only allowlisted tools are ever sent, and the driver exposes no generic call", async () => {
	const ctx = await connected({ snapshotMode: "inline" });
	await ctx.driver.listTabs();
	await ctx.driver.newTab("https://example.com/");
	await ctx.driver.selectTab(0);
	await ctx.driver.closeTab(1);
	await ctx.driver.snapshot(NEVER);
	for (const action of [
		{ kind: "navigate", url: "https://example.com/" },
		{ kind: "back" },
		{ kind: "click", ref: "e1", element: "x" },
		{ kind: "hover", ref: "e1", element: "x" },
		{ kind: "type", ref: "e1", element: "x", text: "t", submit: false },
		{ kind: "select", ref: "e1", element: "x", values: ["a"] },
		{ kind: "press", key: "a" },
		{ kind: "wait", seconds: 1 },
	] satisfies DriverAction[])
		await ctx.driver.act(action, NEVER);
	await ctx.driver.measure("viewport");
	await ctx.driver.measure("element", "e1");
	await ctx.driver.screenshot("viewport", undefined, NEVER);
	const names = new Set(ctx.calls().map((c) => c.name));
	expect([...names].sort()).toEqual([...ALLOWED_MCP_TOOLS].sort());
	for (const forbidden of [
		"browser_run_code_unsafe",
		"browser_file_upload",
		"browser_network_requests",
		"browser_console_messages",
		"browser_drag",
		"browser_fill_form",
		"browser_close",
	])
		expect(names.has(forbidden)).toBe(false);
	expect(Object.keys(ctx.driver).sort()).toEqual(
		[
			"act",
			"closeTab",
			"connect",
			"disconnect",
			"inspectFocused",
			"inspectTarget",
			"listTabs",
			"measure",
			"newTab",
			"onStateChange",
			"screenshot",
			"selectTab",
			"snapshot",
			"state",
		].sort(),
	);
	expect(new BrowserDriverError("x", false).dispatched).toBe(false);
});

test("calls before connect or after disconnect are refused without reaching a child", async () => {
	const ctx = setup();
	await expect(ctx.driver.snapshot(NEVER)).rejects.toMatchObject({
		code: "not_connected",
		dispatched: false,
	});
	expect(await ctx.driver.act({ kind: "back" }, NEVER)).toEqual({
		ok: false,
		code: "not_connected",
		dispatched: false,
	});
	expect(ctx.log()).toEqual([]);
});

test("Bridge token is only passed as child env and extension tabs never leave the adapter", async () => {
	const token = "fixture-bridge-secret";
	const ctx = setup(
		{ initialUrl: `chrome-extension://fixture/connect.html?token=${token}` },
		{ extensionToken: token },
	);
	expect((await ctx.driver.connect(NEVER)).state).toBe("connected");
	expect(ctx.start().envKeys).toEqual(
		[
			"HOME",
			"PATH",
			"PLAYWRIGHT_MCP_EXECUTABLE_PATH",
			"PLAYWRIGHT_MCP_EXTENSION_TOKEN",
		].sort(),
	);
	expect(await ctx.driver.listTabs()).toEqual([]);
	expect(JSON.stringify(ctx.log())).not.toContain(token);
});
