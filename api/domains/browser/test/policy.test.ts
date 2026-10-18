import { afterEach, expect, test } from "bun:test";
import {
	OWNER,
	WEB,
	connect,
	fakeResolver,
	parkedRunner,
	runCleanup,
	setup,
	startRunningTask,
	type Env,
} from "./fakes";

afterEach(runCleanup);
const acts = (env: Env) =>
	env.driver.calls.filter((c) => c.startsWith("act:")).length;
const observe = (env: Env, tabRef: string, taskId: string | null = null) =>
	env.service.observe({ owner: OWNER, taskId, tabRef });
const operate = (
	env: Env,
	tabRef: string | undefined,
	action: unknown,
	taskId: string | null = null,
) => env.service.operate({ owner: OWNER, taskId, tabRef, action });
const statusOf = (env: Env, tabRef: string) =>
	env.service.tabs().find((t) => t.tabRef === tabRef)?.status;

test("a name that resolves to a loopback, private or link-local address is private", async () => {
	const dns: Record<string, string[] | Error> = {
		"rebind.test": ["127.0.0.1"],
		"six.test": ["::1"],
		"mapped.test": ["::ffff:10.0.0.1"],
		"link.test": ["169.254.169.254"],
		"mixed.test": ["93.184.216.34", "10.1.2.3"],
		"gone.test": new Error("ENOTFOUND"),
	};
	const env = setup({ resolveHost: fakeResolver(dns) });
	const tabRef = await connect(env);
	for (const host of ["rebind", "six", "mapped", "link", "mixed"]) {
		await expect(
			operate(env, tabRef, { kind: "navigate", url: `https://${host}.test/` }),
		).rejects.toThrow("navigation_private_blocked");
		await expect(
			operate(env, undefined, {
				kind: "tab_new",
				url: `https://${host}.test/`,
			}),
		).rejects.toThrow("navigation_private_blocked");
	}
	await expect(
		operate(env, tabRef, { kind: "navigate", url: "https://gone.test/" }),
	).rejects.toThrow("navigation_unresolved_blocked");
	expect(acts(env)).toBe(0);
	expect(env.driver.calls.some((c) => c.startsWith("newTab"))).toBe(false);
	// A public name, and the Eumenes web origin without any lookup, are open.
	expect(
		await operate(env, tabRef, {
			kind: "navigate",
			url: "https://example.com/",
		}),
	).toMatchObject({ state: "observed" });
	const looked: string[] = [];
	const spy = setup({
		resolveHost: async (h) => {
			looked.push(h);
			return ["93.184.216.34"];
		},
	});
	const t = await connect(spy);
	await operate(spy, t, { kind: "navigate", url: `${WEB}/settings` });
	expect(looked).toEqual([]);
	await expect(
		operate(spy, t, { kind: "navigate", url: `${WEB}/api/tasks` }),
	).rejects.toThrow("navigation_api_blocked");
});

test("a page an action ended on is checked before it is adopted; the tab is blocked and keeps nothing of it", async () => {
	const env = setup({ runTaskStep: parkedRunner });
	const tabRef = await connect(env);
	const taskId = await startRunningTask(env, tabRef);
	const o = await observe(env, tabRef, taskId);
	env.driver.actResults.push({
		ok: true,
		url: "http://192.168.1.1/admin?token=secret",
		title: "Router login",
	});
	await expect(
		operate(
			env,
			tabRef,
			{
				kind: "click",
				observationRef: o.observationRef,
				ref: "e2",
				element: "Go",
			},
			taskId,
		),
	).rejects.toThrow("navigation_private_blocked");
	expect(statusOf(env, tabRef)).toBe("blocked");
	const tab = env.service.tabs().find((t) => t.tabRef === tabRef)!;
	expect(tab.title).toBe("");
	expect(JSON.stringify(tab)).not.toContain("token");
	const op = env.store.read((db) =>
		db
			.query(
				"SELECT state, error_code, result_url, result_title FROM browser_operations",
			)
			.get(),
	);
	expect(op).toEqual({
		state: "failed",
		error_code: "navigation_private_blocked",
		result_url: null,
		result_title: null,
	});
	// Not operable, not observable, not capturable, not startable.
	await expect(observe(env, tabRef, taskId)).rejects.toThrow("tab_blocked");
	await expect(operate(env, tabRef, { kind: "back" }, taskId)).rejects.toThrow(
		"tab_blocked",
	);
	await expect(
		env.service.startCapture({
			requestId: crypto.randomUUID(),
			owner: OWNER,
			conversationId: "main",
			origin: "screen",
			tabRef,
			range: "viewport",
		}),
	).rejects.toThrow("tab_blocked");
	await expect(
		env.service.startTask({
			owner: OWNER,
			conversationId: "main",
			origin: "screen",
			requestId: crypto.randomUUID(),
			request: "x",
			tabRef,
		}),
	).rejects.toThrow("tab_blocked");
	expect(env.driver.calls.includes("screenshot")).toBe(false);
});

test("an internal page after a navigation is blocked the same way", async () => {
	const env = setup();
	const tabRef = await connect(env);
	env.driver.actResults.push({
		ok: true,
		url: "chrome://settings/passwords",
		title: "Passwords",
	});
	await expect(operate(env, tabRef, { kind: "back" })).rejects.toThrow(
		"navigation_scheme_blocked",
	);
	expect(statusOf(env, tabRef)).toBe("blocked");
});

test("a snapshot of a page the host must not adopt is discarded", async () => {
	const env = setup();
	const tabRef = await connect(env);
	env.driver.snapshotUrl = "http://10.0.0.5/panel";
	await expect(observe(env, tabRef)).rejects.toThrow(
		"navigation_private_blocked",
	);
	expect(statusOf(env, tabRef)).toBe("blocked");
	const kept = env.store.read((db) =>
		db.query("SELECT COUNT(*) AS n FROM browser_observations").get(),
	);
	expect(kept).toEqual({ n: 0 });
	expect(env.service.tabs().find((t) => t.tabRef === tabRef)!.url).toBe(
		`${WEB}/`,
	);
});

test("a tab whose name later resolves to a private address is blocked when its list entry is checked", async () => {
	let clock = Date.now();
	const dns: Record<string, string[] | Error> = {};
	const env = setup({ resolveHost: fakeResolver(dns), now: () => clock });
	await connect(env);
	const opened = await env.service.openTab(
		OWNER,
		null,
		"https://shifty.test/a",
	);
	const tabRef = opened.tabRef!;
	expect(statusOf(env, tabRef)).toBe("idle");
	dns["shifty.test"] = ["10.9.8.7"];
	clock += 20_000;
	await expect(observe(env, tabRef)).rejects.toThrow(
		"navigation_private_blocked",
	);
	expect(statusOf(env, tabRef)).toBe("blocked");
	await expect(observe(env, tabRef)).rejects.toThrow("tab_blocked");
	// The blocked page is not issued a new ref by the next listing either.
	await env.service.refreshTabs();
	expect(
		env.service.tabs().filter((t) => t.url.includes("shifty")),
	).toHaveLength(1);
});

test("tab list entries for internal or private pages never become operable tabs", async () => {
	const env = setup();
	await connect(env);
	env.driver.tabs.push(
		{ index: 1, url: "chrome://settings", title: "Settings", current: false },
		{ index: 2, url: "file:///etc/passwd", title: "passwd", current: false },
		{ index: 3, url: "http://10.0.0.7/", title: "NAS", current: false },
		{ index: 4, url: `${WEB}/api/state`, title: "api", current: false },
		{ index: 5, url: "https://example.com/ok", title: "ok", current: false },
	);
	const tabs = await env.service.refreshTabs();
	expect(
		tabs
			.filter((t) => t.status === "idle")
			.map((t) => t.url)
			.sort(),
	).toEqual([`${WEB}/`, "https://example.com/ok"]);
	expect(JSON.stringify(tabs)).not.toMatch(/passwd|chrome:|10\.0\.0\.7/);
});

test("a tab opened to a page that redirects somewhere private gets no ref", async () => {
	const env = setup();
	await connect(env);
	env.driver.newTab = async (_url: string) => {
		env.driver.calls.push("newTab");
		env.driver.tabs.forEach((t) => (t.current = false));
		env.driver.tabs.push({
			index: env.driver.tabs.length,
			url: "http://127.0.0.1:8080/inner",
			title: "inner",
			current: true,
		});
		return env.driver.tabs.map((t) => ({ ...t }));
	};
	await expect(
		env.service.openTab(OWNER, null, "https://example.com/redirect"),
	).rejects.toThrow("navigation_private_blocked");
	expect(env.service.tabs().filter((t) => t.url.includes("127.0.0.1"))).toEqual(
		[],
	);
});
