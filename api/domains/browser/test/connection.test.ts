import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chmodSync, writeFileSync } from "node:fs";
import { OWNER, connect, fakeBrave, runCleanup, setup, until } from "./fakes";

afterEach(runCleanup);

test("without the Brave path the browser is not configured and connect is refused", async () => {
	const { service, driver } = setup();
	await service.ready;
	expect(service.connection().availability).toEqual({
		available: false,
		reason: "browser_not_configured",
	});
	await expect(service.connect()).rejects.toThrow("browser_not_configured");
	expect(driver.connectCount).toBe(0);
});

test("the setting is saved as an absolute path and an empty path clears it", async () => {
	const { service, dir } = setup();
	const path = fakeBrave(dir);
	expect(await service.setting.save(path)).toEqual({ executablePath: path });
	expect(service.setting.get().executablePath).toBe(path);
	await expect(service.setting.save("brave")).rejects.toThrow();
	expect(await service.setting.save("")).toEqual({ executablePath: null });
	expect(service.connection().configured).toBe(false);
});

test("the setting must be an existing executable regular file", async () => {
	const { service, dir } = setup();
	const plain = join(dir, "plain");
	writeFileSync(plain, "x");
	chmodSync(plain, 0o644);
	await expect(service.setting.save(plain)).rejects.toThrow(
		"browser_executable_invalid",
	);
	await expect(service.setting.save(dir)).rejects.toThrow(
		"browser_executable_invalid",
	);
	await expect(service.setting.save(join(dir, "missing"))).rejects.toThrow(
		"browser_executable_invalid",
	);
	expect(service.setting.get().executablePath).toBeNull();
	chmodSync(plain, 0o755);
	expect(await service.setting.save(plain)).toEqual({ executablePath: plain });
});

test("an existing standard install is offered only while no path is saved", async () => {
	const installs = mkdtempSync(join(tmpdir(), "eumenes-browser-standard-"));
	try {
		const brave = fakeBrave(installs);
		const { service } = setup({
			standardPaths: [join(installs, "missing"), brave],
		});
		expect(await service.setting.suggest()).toBe(brave);
		expect(service.connection().configured).toBe(false);
		await service.setting.save(brave);
		expect(await service.setting.suggest()).toBeNull();
	} finally {
		rmSync(installs, { recursive: true, force: true });
	}
});

test("the chosen file is checked but not saved, and a cancelled dialog chooses nothing", async () => {
	const picks: (string | null)[] = [];
	const { service, dir } = setup({
		pickExecutable: async () => picks.shift() ?? null,
	});
	const brave = fakeBrave(dir);
	picks.push(brave, null, join(dir, "missing"));
	expect(service.setting.canBrowse).toBe(true);
	expect(await service.setting.browse()).toEqual({ path: brave });
	expect(service.setting.get().executablePath).toBeNull();
	expect(await service.setting.browse()).toEqual({ path: null });
	await expect(service.setting.browse()).rejects.toThrow(
		"browser_executable_invalid",
	);
});

test("one dialog at a time, and none without a picker", async () => {
	let close: (path: string | null) => void = () => undefined;
	const { service } = setup({
		pickExecutable: () =>
			new Promise((resolve) => {
				close = resolve;
			}),
	});
	const first = service.setting.browse();
	await expect(service.setting.browse()).rejects.toThrow("browser_browse_busy");
	close(null);
	expect(await first).toEqual({ path: null });
	const plain = setup();
	expect(plain.service.setting.canBrowse).toBe(false);
	await expect(plain.service.setting.browse()).rejects.toThrow(
		"browser_browse_unsupported",
	);
});

test("nothing is offered when no standard install exists", async () => {
	const { service } = setup({ standardPaths: [] });
	expect(await service.setting.suggest()).toBeNull();
});

test("connecting waits for the user's tab, then the tabs get refs and the browser is available", async () => {
	const env = setup();
	const { service, driver } = env;
	driver.autoConnect = false;
	await service.setting.save(fakeBrave(env.dir));
	const first = await service.connect();
	expect(first.state).toBe("connecting");
	expect(first.availability).toEqual({
		available: false,
		reason: "browser_connecting",
	});
	// A second request while one is live joins it.
	expect((await service.connect()).connectionId).toBe(first.connectionId);
	await until(() => driver.connectGate !== null);
	driver.connectGate!({ state: "connected", connectedAt: "now" });
	await until(() => service.connection().state === "connected");
	await service.settled();
	expect(driver.connectCount).toBe(1);
	expect(service.connection().availability).toEqual({ available: true });
	const tabs = service.tabs();
	expect(tabs).toHaveLength(1);
	expect(tabs[0]).toMatchObject({
		url: "http://localhost:5173/",
		active: true,
		status: "idle",
	});
});

test("a connect timeout is a failure the screen can explain, and nothing reconnects", async () => {
	const { service, driver, dir } = setup();
	driver.autoConnect = false;
	await service.setting.save(fakeBrave(dir));
	await service.connect();
	await until(() => driver.connectGate !== null);
	driver.connectGate!({ state: "disconnected", reason: "connect_timeout" });
	await service.settled();
	const view = service.connection();
	expect(view).toMatchObject({ state: "failed", endReason: "connect_timeout" });
	expect(view.availability).toEqual({
		available: false,
		reason: "browser_connect_timeout",
	});
	await Bun.sleep(30);
	expect(driver.connectCount).toBe(1);
});

test("a driver that cannot start ends as mcp_unavailable", async () => {
	const { service, driver, dir } = setup();
	await service.setting.save(fakeBrave(dir));
	driver.connect = async () => {
		throw new Error("spawn failed");
	};
	await service.connect();
	await service.settled();
	expect(service.connection()).toMatchObject({
		state: "failed",
		endReason: "mcp_unavailable",
	});
	expect(service.connection().availability).toEqual({
		available: false,
		reason: "browser_mcp_unavailable",
	});
});

test("the user's disconnect ends the connection and every tab ref stops working", async () => {
	const env = setup();
	const tabRef = await connect(env);
	const { service, driver } = env;
	await service.disconnect();
	expect(service.connection()).toMatchObject({
		state: "disconnected",
		endReason: "user",
	});
	expect(driver.calls).toContain("disconnect");
	expect(service.tabs()[0]).toMatchObject({ tabRef, status: "closed" });
	await expect(
		service.observe({ owner: OWNER, taskId: null, tabRef }),
	).rejects.toThrow("browser_disconnected");
	// Nothing reconnects on its own.
	await Bun.sleep(30);
	expect(driver.connectCount).toBe(1);
});

test("Brave closing ends the connection through the driver's state change", async () => {
	const env = setup();
	await connect(env);
	env.driver.emit({ state: "disconnected", reason: "browser_closed" });
	await until(() => env.service.connection().state === "disconnected");
	expect(env.service.connection().endReason).toBe("browser_closed");
	expect(env.service.tabs()[0]!.status).toBe("closed");
	expect(env.service.connection().availability).toEqual({
		available: false,
		reason: "browser_disconnected",
	});
});

test("a backend restart ends the old connection, loses its tabs and leaves operations indeterminate", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-browser-restart-"));
	try {
		const first = setup({
			dir,
			runTaskStep: async () => ({
				kind: "continue",
				coreState: {},
				delayMs: 60_000,
			}),
		});
		const tabRef = await connect(first);
		const task = await first.service.startTask({
			owner: OWNER,
			conversationId: "main",
			origin: "screen",
			requestId: crypto.randomUUID(),
			request: "open the settings",
			tabRef,
		});
		await until(() => first.service.taskRow(task.taskId)!.state === "running");
		// An operation is in flight (dispatched, no answer) when the process dies.
		first.driver.actGate = new Promise(() => undefined);
		void first.service
			.operate({
				owner: OWNER,
				taskId: task.taskId,
				tabRef,
				action: { kind: "back" },
			})
			.catch(() => undefined);
		await until(() => first.driver.calls.includes("act:back"));
		await runCleanupKeepDir();

		const second = setup({ dir });
		await second.service.ready;
		const view = second.service.connection();
		expect(view).toMatchObject({
			state: "disconnected",
			endReason: "backend_restart",
		});
		expect(second.service.tabs()[0]).toMatchObject({
			tabRef,
			status: "closed",
		});
		const status = second.service.taskStatus(OWNER, task.taskId);
		expect(status.state).toBe("indeterminate");
		expect(status.operations.map((o) => o.state)).toEqual(["indeterminate"]);
	} finally {
		await runCleanup();
		rmSync(dir, { recursive: true, force: true });
	}
});

async function runCleanupKeepDir() {
	// The fakes only remove directories they created; this one belongs to the test.
	await runCleanup();
}
