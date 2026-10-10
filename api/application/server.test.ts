import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfig } from "../infrastructure/config";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
const tempDir = () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-server-"));
	dirs.push(dir);
	return dir;
};

test("importing server.ts has no side effects", async () => {
	const signals = [
		process.listenerCount("SIGINT"),
		process.listenerCount("SIGTERM"),
	];
	const mod = await import("./server");
	expect(typeof mod.buildServices).toBe("function");
	expect([
		process.listenerCount("SIGINT"),
		process.listenerCount("SIGTERM"),
	]).toEqual(signals);
});

test("a separate process that imports server.ts neither starts nor touches the data directory, and exits by itself", async () => {
	const dir = tempDir();
	const child = Bun.spawn(
		[
			process.execPath,
			"-e",
			'await import("./api/application/server.ts"); console.log("imported");',
		],
		{
			cwd: resolve(import.meta.dir, "../.."),
			stdout: "pipe",
			stderr: "pipe",
			env: {
				...process.env,
				EUMENES_DB: join(dir, "db.sqlite3"),
				EUMENES_PORT: "0",
			},
		},
	);
	expect(await child.exited).toBe(0);
	expect(await new Response(child.stdout).text()).toBe("imported\n");
	expect(await new Response(child.stderr).text()).toBe("");
	expect(readdirSync(dir)).toEqual([]);
}, 20_000);

test("the shutdown order is fixed, and a freshly built set of services closes cleanly through it", async () => {
	const dir = tempDir();
	const { buildServices, createLifecycles } = await import("./server");
	const { createLifecycleRunner } = await import("./lifecycle");
	const services = await buildServices(
		loadConfig({
			EUMENES_DB: join(dir, "db.sqlite3"),
			EUMENES_TOOLCHAIN_ENABLED: "0",
			EUMENES_WORLD: "protect",
		}),
	);
	const items = createLifecycles(services, { name: "http", close: () => {} });
	expect(
		items
			.filter((item) => item.close)
			.map((item) => item.name)
			.reverse(),
	).toEqual([
		"commits",
		"status",
		"changes",
		"http",
		"timers",
		"coding_execution",
		"coding",
		"timer_maintenance",
		"store_retention",
		"task_report_delivery",
		"task_maintenance",
		"world",
		"world_foreground",
		"supervision",
		"delegated",
		"scheduler",
		"service_tests",
		"voice",
		"agents",
		"capabilities",
		"queue",
		"web_research",
		"dialogue",
		"inference",
		"attitude_dataset",
		"dataset_store",
		"store",
	]);
	expect(await createLifecycleRunner(items).closeAll(15_000)).toBe(true);
}, 30_000);

/** Starts the real server entry point in a child process with isolated state. */
function spawnServer(dir: string, port: string) {
	const logFile = join(dir, "api.jsonl");
	const child = Bun.spawn([process.execPath, "api/application/server.ts"], {
		cwd: resolve(import.meta.dir, "../.."),
		stdout: "ignore",
		stderr: "pipe",
		env: {
			...process.env,
			EUMENES_DB: join(dir, "db.sqlite3"),
			EUMENES_LOG_FILE: logFile,
			EUMENES_PORT: port,
			EUMENES_TOOLCHAIN_ENABLED: "0",
			EUMENES_WORLD: "protect",
			EUMENES_KEY_DIR: join(dir, "keys"),
			EUMENES_API_TOKEN: "t".repeat(32),
		},
	});
	const decoder = new TextDecoder();
	let buffered = "";
	const reader = child.stderr.getReader();
	/** Reads stderr until a log line for `event` appears. */
	async function waitFor(event: string) {
		while (!buffered.includes(`"event":"${event}"`)) {
			const chunk = await reader.read();
			if (chunk.done) throw new Error(`child ended before ${event}`);
			buffered += decoder.decode(chunk.value);
		}
	}
	/** Drains the rest of stderr so the child never blocks on a full pipe. */
	async function drain() {
		for (;;) {
			const chunk = await reader.read();
			if (chunk.done) return;
			buffered += decoder.decode(chunk.value);
		}
	}
	const events = () =>
		buffered
			.split("\n")
			.filter((line) => line.startsWith("{"))
			.map(
				(line) =>
					JSON.parse(line) as { event: string; reason?: string; port?: number },
			);
	return { child, waitFor, drain, events };
}

test("SIGTERM after startup shuts down through closeAll and exits 0", async () => {
	const dir = tempDir();
	const server = spawnServer(dir, "0");
	try {
		await server.waitFor("server.listening");
		server.child.kill("SIGTERM");
		const [code] = await Promise.all([server.child.exited, server.drain()]);
		expect(code).toBe(0);
		const events = server.events().map((entry) => entry.event);
		expect(events).toContain("server.shutdown_started");
		expect(events).toContain("server.shutdown_completed");
	} finally {
		server.child.kill("SIGKILL");
	}
}, 40_000);

test("a busy port fails with port_in_use after closing", async () => {
	const dir = tempDir();
	const busy = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () => new Response("busy"),
	});
	const server = spawnServer(dir, String(busy.port));
	try {
		const [code] = await Promise.all([server.child.exited, server.drain()]);
		expect(code).toBe(1);
		const events = server.events();
		const failed = events.find(
			(entry) => entry.event === "server.startup_failed",
		);
		expect(failed?.reason).toBe("port_in_use");
		// The services were closed before the process gave up.
		expect(events.map((entry) => entry.event)).toContain(
			"server.shutdown_completed",
		);
	} finally {
		server.child.kill("SIGKILL");
		busy.stop(true);
	}
}, 40_000);

test("startupFailureReason passes only allow-listed codes", async () => {
	const { startupFailureReason } = await import("./server");
	const cases: [string, string][] = [
		[
			"migration_checksum_mismatch:conversation/0006-x",
			"migration_checksum_mismatch:conversation/0006-x",
		],
		["database_writer_owned", "database_writer_owned"],
		["secret_key_missing", "secret_key_missing"],
		["port_in_use", "port_in_use"],
		["config_invalid:EUMENES_PORT", "config_invalid:EUMENES_PORT"],
		["EUMENES_API_TOKEN must be at least 24 characters", "api_token_too_short"],
		["ENOENT: /home/user/secret", "startup_failed"],
		["migration_checksum_mismatch:../../etc", "startup_failed"],
		["x".repeat(500), "startup_failed"],
	];
	for (const [message, expected] of cases)
		expect(startupFailureReason(new Error(message))).toBe(expected);
	expect(startupFailureReason("port_in_use")).toBe("startup_failed");
});
