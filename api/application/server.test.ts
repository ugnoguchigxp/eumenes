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
