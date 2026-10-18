import { afterEach, expect, test } from "bun:test";
import {
	OWNER,
	WEB,
	connect,
	leaseOf,
	parkedRunner,
	runCleanup,
	setup,
	startRunningTask,
	until,
} from "./fakes";

afterEach(runCleanup);
const observe = (
	env: ReturnType<typeof setup>,
	tabRef: string,
	taskId: string | null = null,
) => env.service.observe({ owner: OWNER, taskId, tabRef });

test("a tab whose URL changed is lost, never swapped for a similar tab", async () => {
	const env = setup();
	const tabRef = await connect(env);
	env.driver.tabs[0]!.url = `${WEB}/elsewhere`;
	await expect(observe(env, tabRef)).rejects.toThrow("tab_lost");
	const tabs = env.service.tabs();
	expect(tabs.find((t) => t.tabRef === tabRef)!.status).toBe("closed");
	// The changed tab is listed under a new ref instead.
	const fresh = tabs.find((t) => t.url === `${WEB}/elsewhere`)!;
	expect(fresh.tabRef).not.toBe(tabRef);
	await expect(observe(env, tabRef)).rejects.toThrow("tab_lost");
	expect(await observe(env, fresh.tabRef)).toMatchObject({
		url: `${WEB}/elsewhere`,
	});
});

test("a closed tab is lost, and closing a tab before it shifts indexes without making it match another", async () => {
	const env = setup();
	const first = await connect(env);
	await env.service.openTab(OWNER, null, "https://example.com/a");
	await env.service.openTab(OWNER, null, "https://example.com/b");
	const tabs = env.service.tabs();
	const b = tabs.find((t) => t.url.endsWith("/b"))!.tabRef;
	// The user closes the first tab in Brave: index 1 and 2 are now 0 and 1.
	env.driver.tabs.splice(0, 1);
	env.driver.tabs.forEach((t, i) => (t.index = i));
	await expect(observe(env, b)).rejects.toThrow("tab_lost");
	await expect(observe(env, first)).rejects.toThrow("tab_lost");
	const live = (await env.service.refreshTabs()).filter(
		(t) => t.status !== "closed",
	);
	expect(live.map((t) => t.url)).toEqual([
		"https://example.com/a",
		"https://example.com/b",
	]);
});

test("closing a tab through the host keeps the others addressable", async () => {
	const env = setup();
	const first = await connect(env);
	await env.service.openTab(OWNER, null, "https://example.com/a");
	const b = (await env.service.openTab(OWNER, null, "https://example.com/b"))
		.tabRef!;
	await env.service.closeTab(
		OWNER,
		null,
		(await env.service.refreshTabs()).find((t) => t.url.endsWith("/a"))!.tabRef,
	);
	expect(await observe(env, b)).toMatchObject({ url: "https://example.com/b" });
	expect(await observe(env, first)).toMatchObject({ url: `${WEB}/` });
});

test("driver call sequences never overlap: select and act are one section per connection", async () => {
	const env = setup();
	const first = await connect(env);
	const second = (
		await env.service.openTab(OWNER, null, "https://example.com/b")
	).tabRef!;
	env.driver.calls.length = 0;
	let release!: () => void;
	env.driver.actGate = new Promise<void>((r) => (release = r));
	const op = env.service.operate({
		owner: OWNER,
		taskId: null,
		tabRef: first,
		action: { kind: "back" },
	});
	await until(() => env.driver.calls.includes("act:back"));
	const mark = env.driver.calls.length;
	const other = observe(env, second);
	await Bun.sleep(40);
	// The second sequence has not issued a single call while the first is inside its section.
	expect(env.driver.calls.length).toBe(mark);
	release();
	await op;
	await other;
	expect(env.driver.maxActive).toBe(1);
	expect(env.driver.calls.slice(0, 5)).toEqual([
		"listTabs",
		"selectTab:0",
		"act:back",
		"listTabs",
		"selectTab:1",
	]);
	expect(env.driver.calls.at(-1)).toBe("snapshot");
});

test("a tab leased to a task is busy for another task and for a standalone call", async () => {
	const env = setup({ runTaskStep: parkedRunner });
	const tabRef = await connect(env);
	const a = await startRunningTask(env, tabRef);
	const b = await startRunningTask(env, tabRef, "another job");
	await observe(env, tabRef, a);
	expect(env.service.tabs()[0]).toMatchObject({
		status: "busy",
		currentTaskLabel: "open the settings page",
	});
	await expect(observe(env, tabRef, b)).rejects.toThrow("tab_busy");
	await expect(observe(env, tabRef)).rejects.toThrow("tab_busy");
	await expect(
		env.service.operate({
			owner: OWNER,
			taskId: b,
			tabRef,
			action: { kind: "back" },
		}),
	).rejects.toThrow("tab_busy");
	// The owner of the lease keeps working.
	await observe(env, tabRef, a);
	// Ending the task frees the tab.
	await env.service.cancelTask(OWNER, a);
	expect(leaseOf(env, tabRef).holder).toBeNull();
	await observe(env, tabRef, b);
});

test("an expired lease is reclaimed with a new epoch and the old holder is refused", async () => {
	let clock = Date.now();
	const env = setup({
		runTaskStep: parkedRunner,
		leaseMs: 1000,
		now: () => clock,
	});
	const tabRef = await connect(env);
	const a = await startRunningTask(env, tabRef);
	await observe(env, tabRef, a);
	const held = leaseOf(env, tabRef);
	expect(held.holder).toBe(a);
	await expect(observe(env, tabRef)).rejects.toThrow("tab_busy");
	clock += 1500;
	// Past its expiry, another holder takes the tab and the epoch moves.
	const b = await startRunningTask(env, tabRef, "second job");
	await observe(env, tabRef, b);
	const taken = leaseOf(env, tabRef);
	expect(taken.holder).toBe(b);
	expect(taken.epoch).toBe(held.epoch + 1);
	await expect(observe(env, tabRef, a)).rejects.toThrow("tab_busy");
	// Reclaiming one's own expired lease also bumps the epoch.
	clock += 1500;
	await observe(env, tabRef, b);
	expect(leaseOf(env, tabRef).epoch).toBe(taken.epoch + 1);
});

test("a lease never runs past the task's deadline", async () => {
	let clock = Date.now();
	const env = setup({
		runTaskStep: parkedRunner,
		leaseMs: 60_000,
		taskMs: 5000,
		now: () => clock,
	});
	const tabRef = await connect(env);
	const id = await startRunningTask(env, tabRef);
	await observe(env, tabRef, id);
	const deadline = env.service.taskRow(id)!.deadline;
	expect(leaseOf(env, tabRef).expires).toBe(deadline);
	clock = deadline + 1;
	await expect(observe(env, tabRef, id)).rejects.toThrow();
});

test("the lease is renewed while an operation runs", async () => {
	const env = setup({ leaseMs: 80, renewMs: 15 });
	const tabRef = await connect(env);
	let release!: () => void;
	env.driver.actGate = new Promise<void>((r) => (release = r));
	const op = env.service.operate({
		owner: OWNER,
		taskId: null,
		tabRef,
		action: { kind: "back" },
	});
	await until(() => env.driver.calls.includes("act:back"));
	const first = leaseOf(env, tabRef).expires!;
	await Bun.sleep(120);
	expect(leaseOf(env, tabRef).expires!).toBeGreaterThan(first);
	release();
	expect(await op).toMatchObject({ state: "observed" });
	expect(leaseOf(env, tabRef).holder).toBeNull();
});

test("tabs sharing a URL keep their refs while nothing moves, and none is re-bound once an index shifts", async () => {
	const env = setup();
	await connect(env);
	const a = (await env.service.openTab(OWNER, null, "https://example.com/same"))
		.tabRef!;
	const b = (await env.service.openTab(OWNER, null, "https://example.com/same"))
		.tabRef!;
	expect(a).not.toBe(b);
	// Unchanged: both stay addressable.
	expect(await observe(env, a)).toMatchObject({ tabRef: a });
	expect(await observe(env, b)).toMatchObject({ tabRef: b });
	// The user closes the first of the two in Brave: the survivor moves from index 2 to 1. Neither ref may
	// end up on a tab it was not issued for.
	env.driver.tabs.splice(1, 1);
	env.driver.tabs.forEach((t, i) => (t.index = i));
	await expect(observe(env, b)).rejects.toThrow("tab_lost");
	await expect(observe(env, a)).rejects.toThrow("tab_lost");
	const live = (await env.service.refreshTabs()).filter(
		(t) => t.status === "idle",
	);
	expect(live.map((t) => t.url).sort()).toEqual([
		`${WEB}/`,
		"https://example.com/same",
	]);
	const survivor = live.find((t) => t.url.endsWith("/same"))!;
	expect([a, b]).not.toContain(survivor.tabRef);
});

test("a duplicate that appears next to a tracked tab does not take its ref", async () => {
	const env = setup();
	await connect(env);
	const a = (await env.service.openTab(OWNER, null, "https://example.com/dup"))
		.tabRef!;
	// A second tab with the same URL is inserted before it, pushing it to the next index.
	env.driver.tabs.splice(1, 0, {
		index: 1,
		url: "https://example.com/dup",
		title: "inserted",
		current: false,
	});
	env.driver.tabs.forEach((t, i) => (t.index = i));
	await expect(observe(env, a)).rejects.toThrow("tab_lost");
});
