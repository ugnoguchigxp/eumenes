import { expect, test } from "bun:test";
import { loadConfig, parseWorldMode } from "./config";

test("defaults are the values the server used before the config was centralised", () => {
	const config = loadConfig({});
	expect({ ...config, env: undefined }).toEqual({
		dbPath: "./data/eumenes.sqlite3",
		logFile: "data/logs/api.jsonl",
		logLevel: undefined,
		host: "127.0.0.1",
		port: 8787,
		origin: "http://127.0.0.1:5173",
		apiToken: undefined,
		larmToken: undefined,
		attitudeDatasetPath: "data/attitude-dataset/dataset.sqlite3",
		memoryJournalPath: "data/memory-forget-journal.jsonl",
		worldJournalPath: undefined,
		codingRunnerConfig: undefined,
		worldMode: "off",
		worldPollMs: undefined,
		worldCursorSecret: undefined,
		toolchainEnabled: true,
		historyToolsEnabled: true,
		webResearchToolsEnabled: true,
		delegatedTasksEnabled: false,
		env: undefined,
	});
});

test("derived paths follow the database directory", () => {
	const config = loadConfig({ EUMENES_DB: "/srv/e/db.sqlite3" });
	expect(config.logFile).toBe("/srv/e/logs/api.jsonl");
	expect(config.attitudeDatasetPath).toBe(
		"/srv/e/attitude-dataset/dataset.sqlite3",
	);
	expect(config.memoryJournalPath).toBe("/srv/e/memory-forget-journal.jsonl");
});

test("explicit values, the log file switch, and empty strings as unset", () => {
	const config = loadConfig({
		EUMENES_DB: "/d/db",
		EUMENES_LOG_FILE: "-",
		EUMENES_LOG_LEVEL: "debug",
		EUMENES_HOST: "localhost",
		EUMENES_PORT: "0",
		EUMENES_ORIGIN: "http://x",
		EUMENES_API_TOKEN: "t",
		LARM_CONTROL_TOKEN: " c ",
		EUMENES_ATTITUDE_DATASET: "/a",
		EUMENES_MEMORY_JOURNAL: "/m",
		EUMENES_WORLD_JOURNAL: "/w",
		EUMENES_CODING_RUNNER_CONFIG: "/c.json",
		EUMENES_WORLD_CURSOR_SECRET: "s",
	});
	expect(config).toMatchObject({
		logFile: undefined,
		logLevel: "debug",
		host: "localhost",
		port: 0,
		origin: "http://x",
		apiToken: "t",
		larmToken: "c",
		attitudeDatasetPath: "/a",
		memoryJournalPath: "/m",
		worldJournalPath: "/w",
		codingRunnerConfig: "/c.json",
		worldCursorSecret: "s",
	});
	// `VAR= cmd` clears a value.
	expect(
		loadConfig({
			EUMENES_PORT: "",
			EUMENES_LOG_FILE: "",
			EUMENES_TOOLCHAIN_ENABLED: "",
			LARM_API_TOKEN: "",
		}),
	).toMatchObject({
		port: 8787,
		logFile: "data/logs/api.jsonl",
		toolchainEnabled: true,
		larmToken: undefined,
	});
});

test("LARM_API_TOKEN wins over LARM_CONTROL_TOKEN", () => {
	expect(
		loadConfig({ LARM_API_TOKEN: "a", LARM_CONTROL_TOKEN: "b" }).larmToken,
	).toBe("a");
});

test("flags: 1/true/on and 0/false/off; anything else fails with the variable name only", () => {
	for (const value of ["1", "true", "ON", " On "]) {
		expect(
			loadConfig({ EUMENES_TOOLCHAIN_ENABLED: value }).toolchainEnabled,
		).toBe(true);
		expect(
			loadConfig({ EUMENES_DELEGATED_TASKS_ENABLED: value })
				.delegatedTasksEnabled,
		).toBe(true);
	}
	for (const value of ["0", "false", "OFF"]) {
		expect(
			loadConfig({ EUMENES_TOOLCHAIN_ENABLED: value }).toolchainEnabled,
		).toBe(false);
		expect(
			loadConfig({ EUMENES_DELEGATED_TASKS_ENABLED: value })
				.delegatedTasksEnabled,
		).toBe(false);
	}
	expect(() => loadConfig({ EUMENES_TOOLCHAIN_ENABLED: "maybe" })).toThrow(
		"config_invalid:EUMENES_TOOLCHAIN_ENABLED",
	);
	expect(() => loadConfig({ EUMENES_DELEGATED_TASKS_ENABLED: "yes" })).toThrow(
		"config_invalid:EUMENES_DELEGATED_TASKS_ENABLED",
	);
});

test("EUMENES_WORLD keeps its three modes and the 0/false/1/true aliases", () => {
	for (const value of [undefined, "", "off", "OFF", "0", "false"])
		expect(loadConfig({ EUMENES_WORLD: value }).worldMode).toBe("off");
	expect(loadConfig({ EUMENES_WORLD: "protect" }).worldMode).toBe("protect");
	for (const value of ["on", "ON", "1", "true"])
		expect(loadConfig({ EUMENES_WORLD: value }).worldMode).toBe("on");
	for (const value of ["onn", "enabled", "2", "protected"])
		expect(() => loadConfig({ EUMENES_WORLD: value })).toThrow(
			"config_invalid:EUMENES_WORLD",
		);
	expect(parseWorldMode(undefined)).toBe("off");
	expect(() => parseWorldMode("typo")).toThrow("world_mode_invalid");
});

test("numbers are validated; the World poll keeps its 1000 ms floor", () => {
	for (const [name, value] of [
		["EUMENES_PORT", "abc"],
		["EUMENES_PORT", "1.5"],
		["EUMENES_PORT", "-1"],
		["EUMENES_PORT", "65536"],
		["EUMENES_WORLD_POLL_MS", "NaN"],
		["EUMENES_WORLD_POLL_MS", "-5"],
		["EUMENES_WORLD_POLL_MS", "1.5"],
	] as const)
		expect(() => loadConfig({ [name]: value })).toThrow(
			`config_invalid:${name}`,
		);
	expect(loadConfig({ EUMENES_PORT: "9000" }).port).toBe(9000);
	expect(loadConfig({ EUMENES_WORLD_POLL_MS: "0" }).worldPollMs).toBe(1000);
	expect(loadConfig({ EUMENES_WORLD_POLL_MS: "500" }).worldPollMs).toBe(1000);
	expect(loadConfig({ EUMENES_WORLD_POLL_MS: "5000" }).worldPollMs).toBe(5000);
});

test("an invalid value never appears in the error", () => {
	try {
		loadConfig({ EUMENES_PORT: "super-secret-not-a-number" });
		throw new Error("expected failure");
	} catch (error) {
		expect(String(error)).not.toContain("super-secret");
	}
});

test("the raw environment is kept for Settings", () => {
	const env = { EUMENES_CLOUD_KEY: "k" };
	expect(loadConfig(env).env).toBe(env);
});

test("history and web research switches are independent typed flags", () => {
	const defaults = loadConfig({});
	expect(defaults.historyToolsEnabled).toBe(true);
	expect(defaults.webResearchToolsEnabled).toBe(true);
	const history = loadConfig({
		EUMENES_WEB_RESEARCH_TOOLS_ENABLED: "off",
		EUMENES_HISTORY_TOOLS_ENABLED: "on",
	});
	expect(history.historyToolsEnabled).toBe(true);
	expect(history.webResearchToolsEnabled).toBe(false);
	expect(() =>
		loadConfig({ EUMENES_HISTORY_TOOLS_ENABLED: "invalid" }),
	).toThrow("config_invalid:EUMENES_HISTORY_TOOLS_ENABLED");
});

test("whitespace-only values are unset, and the World enum is still trimmed", () => {
	expect(
		loadConfig({
			EUMENES_PORT: " ",
			EUMENES_WORLD_POLL_MS: "\t",
			EUMENES_DB: "  ",
			EUMENES_TOOLCHAIN_ENABLED: " ",
			EUMENES_WORLD: " ",
			LARM_API_TOKEN: " ",
		}),
	).toMatchObject({
		port: 8787,
		worldPollMs: undefined,
		dbPath: "./data/eumenes.sqlite3",
		toolchainEnabled: true,
		worldMode: "off",
		larmToken: undefined,
	});
	expect(loadConfig({ EUMENES_WORLD: " protect " }).worldMode).toBe("protect");
	expect(parseWorldMode(" ")).toBe("off");
	expect(loadConfig({ EUMENES_PORT: " 9000 " }).port).toBe(9000);
});

test("numbers are strict decimal: hex, exponent, signs and fractions are rejected", () => {
	for (const value of ["0x1F", "1e3", "+80", "1_000", "9000abc", "٣"])
		expect(() => loadConfig({ EUMENES_PORT: value })).toThrow(
			"config_invalid:EUMENES_PORT",
		);
	for (const value of ["0x1F", "1e3", "Infinity", "99999999999999999999"])
		expect(() => loadConfig({ EUMENES_WORLD_POLL_MS: value })).toThrow(
			"config_invalid:EUMENES_WORLD_POLL_MS",
		);
	expect(loadConfig({ EUMENES_PORT: "007" }).port).toBe(7);
});
