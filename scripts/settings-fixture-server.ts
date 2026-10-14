import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../api/application/app";
import { appModules } from "../api/application/app-modules";
import { createLifecycleRunner } from "../api/application/lifecycle";
import {
	appServices,
	buildServices,
	createLifecycles,
} from "../api/application/server";
import { migrations } from "../api/application/migrations";
import { createSettings } from "../api/domains/settings";
import { loadConfig } from "../api/infrastructure/config";
import { openStore } from "../api/infrastructure/sqlite";
import { configureLogging } from "../api/infrastructure/logger";

/**
 * The real application services on a temporary database for the data-driven settings browser
 * specs: World ON, delegated tasks (dots) enabled, no LARM and no Codex. Listens on
 * EUMENES_PORT with the fixed fixture token; EUMENES_ORIGIN is the Web origin.
 */
const TOKEN = "fixture-token-for-toolchain-browser";
const dir = mkdtempSync(join(tmpdir(), "eumenes-settings-fixture-"));
const config = loadConfig({
	EUMENES_DB: join(dir, "eumenes.sqlite3"),
	EUMENES_KEY_DIR: join(dir, "keys"),
	EUMENES_LOG_FILE: "-",
	EUMENES_HOST: "127.0.0.1",
	EUMENES_PORT: process.env.EUMENES_PORT ?? "0",
	EUMENES_ORIGIN: process.env.EUMENES_ORIGIN ?? "http://127.0.0.1:5173",
	EUMENES_API_TOKEN: TOKEN,
	EUMENES_ATTITUDE_DATASET: join(dir, "attitude-dataset/dataset.sqlite3"),
	EUMENES_MEMORY_JOURNAL: join(dir, "memory-forget-journal.jsonl"),
	EUMENES_WORLD_POLL_MS: "3600000",
	EUMENES_DELEGATED_TASKS_ENABLED: "1",
	EUMENES_WEB_RESEARCH_TOOLS_ENABLED: "0",
});
configureLogging({ file: config.logFile, level: config.logLevel });

let server: ReturnType<typeof Bun.serve> | undefined;
// World ON is a saved setting read at startup, so it is saved before the services are built.
{
	const store = openStore(config.dbPath, migrations);
	const settings = await createSettings(store, {
		dbPath: config.dbPath,
		env: {},
	});
	const saved = settings.get();
	saved.world.enabled = true;
	await settings.apply({
		requestId: crypto.randomUUID(),
		expectedRevision: saved.revision,
		settings: saved,
		keys: [],
	});
	await store.close();
}
const services = await buildServices(config);
const runner = createLifecycleRunner(
	createLifecycles(services, {
		name: "http",
		close: () => server?.stop(true),
	}),
);
await runner.recoverAll();
await runner.startAll();
const app = createApp({
	token: TOKEN,
	origin: config.origin,
	modules: appModules(appServices(services)),
});
server = Bun.serve({
	hostname: config.host,
	port: config.port,
	fetch: app.fetch,
	// SSE heartbeats are 15 s apart; Bun's default 10 s idle timeout would drop the stream.
	idleTimeout: 60,
});
console.log(JSON.stringify({ port: server.port }));
for (const signal of ["SIGTERM", "SIGINT"] as const)
	process.on(signal, () => {
		void (async () => {
			await runner.closeAll(10_000);
			rmSync(dir, { recursive: true, force: true });
			process.exit(0);
		})();
	});
