import { expect, test } from "bun:test";
import {
	BrowserDriverError,
	type BrowserDriver,
	type DriverConnectionState,
} from "../../domains/browser";
import { createSavedPathDriver } from "./browser-driver";

/** A driver that records the path it was built with and lets the test end its connection. */
function fakeDriver(path: string | undefined) {
	let state: DriverConnectionState = { state: "disconnected" };
	const listeners = new Set<(s: DriverConnectionState) => void>();
	const calls: string[] = [];
	const driver: BrowserDriver = {
		async connect() {
			calls.push("connect");
			state = { state: "connected", connectedAt: "now" };
			return state;
		},
		async disconnect() {
			calls.push("disconnect");
			state = { state: "disconnected", reason: "user" };
		},
		state: () => state,
		onStateChange(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		listTabs: async () => {
			calls.push("listTabs");
			return [];
		},
		selectTab: async () => [],
		newTab: async () => [],
		closeTab: async () => [],
		snapshot: async () => ({ url: "", title: "", snapshot: "" }),
		act: async () => ({ ok: true, url: "", title: "" }),
		inspectTarget: async () => ({
			tag: "button",
			inForm: false,
			submits: false,
		}),
		inspectFocused: async () => ({
			tag: "body",
			inForm: false,
			submits: false,
		}),
		measure: async () => ({ width: 1, height: 1, devicePixelRatio: 1 }),
		screenshot: async () => new Uint8Array(),
	};
	return {
		path,
		driver,
		calls,
		end(reason: "browser_closed" | "process_exited") {
			state = { state: "disconnected", reason };
			for (const l of listeners) l(state);
		},
	};
}

function setup() {
	const made: ReturnType<typeof fakeDriver>[] = [];
	let saved: string | undefined = "/first/brave";
	const driver = createSavedPathDriver({
		executablePath: () => saved,
		create(path) {
			const fake = fakeDriver(path);
			made.push(fake);
			return fake.driver;
		},
	});
	const events: DriverConnectionState[] = [];
	driver.onStateChange((s) => events.push(s));
	return {
		driver,
		made,
		events,
		save(path: string | undefined) {
			saved = path;
		},
	};
}

const signal = new AbortController().signal;

test("each connect builds a driver with the path saved at that moment", async () => {
	const { driver, made, save } = setup();
	await driver.connect(signal);
	expect(made.map((m) => m.path)).toEqual(["/first/brave"]);
	await driver.disconnect();
	save("/second/brave");
	await driver.connect(signal);
	expect(made.map((m) => m.path)).toEqual(["/first/brave", "/second/brave"]);
	// The replaced driver is stopped once more, which is harmless.
	expect(made[0]!.calls.slice(0, 2)).toEqual(["connect", "disconnect"]);
});

test("a connect while connected reuses the live driver", async () => {
	const { driver, made } = setup();
	await driver.connect(signal);
	await driver.connect(signal);
	expect(made).toHaveLength(1);
	expect(made[0]!.calls).toEqual(["connect", "connect"]);
});

test("calls go to the live driver and fail as disconnected before any connect", async () => {
	const { driver, made } = setup();
	await expect(driver.listTabs()).rejects.toMatchObject({
		code: "browser_disconnected",
	});
	await expect(driver.listTabs()).rejects.toBeInstanceOf(BrowserDriverError);
	await driver.connect(signal);
	await driver.listTabs();
	expect(made[0]!.calls).toContain("listTabs");
	expect(driver.state().state).toBe("connected");
});

test("state changes of the current driver are passed on; a replaced one is silent", async () => {
	const { driver, made, events } = setup();
	await driver.connect(signal);
	made[0]!.end("browser_closed");
	expect(events).toEqual([{ state: "disconnected", reason: "browser_closed" }]);
	await driver.connect(signal);
	expect(made).toHaveLength(2);
	made[0]!.end("process_exited");
	expect(events).toHaveLength(1);
	made[1]!.end("process_exited");
	expect(events.at(-1)).toEqual({
		state: "disconnected",
		reason: "process_exited",
	});
});

test("an unsaved path is handed on as undefined", async () => {
	const { driver, made, save } = setup();
	save(undefined);
	await driver.connect(signal);
	expect(made[0]!.path).toBeUndefined();
});

test("close stops the child without reporting and refuses later connects", async () => {
	const { driver, made, events } = setup();
	await driver.connect(signal);
	await driver.close();
	expect(made[0]!.calls).toContain("disconnect");
	made[0]!.end("process_exited");
	expect(events).toEqual([]);
	expect(await driver.connect(signal)).toMatchObject({
		state: "disconnected",
	});
	expect(made).toHaveLength(1);
});
