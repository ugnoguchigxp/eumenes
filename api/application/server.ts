import { configureLogging, getLogger } from "../infrastructure/logger";
import { resolveApiToken } from "../infrastructure/auth-config";
import { loadProcessConfig } from "../infrastructure/config";
import { createApp } from "./app";
import { appModules } from "./app-modules";
import {
	createLifecycleRunner,
	createProcessGuard,
	createTerminator,
} from "./lifecycle";
import { appServices } from "./server-app-services";
import { createLifecycles } from "./server-lifecycles";
import { buildServices } from "./server-services";
import {
	PROCESS_SHUTDOWN_DEADLINE_MS,
	SHUTDOWN_DEADLINE_MS,
	createStartupGate,
} from "../infrastructure/shutdown";

const log = getLogger("server");

// Resources that `buildServices` created before it threw are not registered
// with the runner, so they cannot be closed here; the process exit releases the
// flock and the files.
async function main() {
	const config = loadProcessConfig();
	configureLogging({ file: config.logFile, level: config.logLevel });
	// Resolved lazily: the guard is armed before the terminator exists.
	let terminate: () => void = () => process.exit(1);
	const guard = createProcessGuard({ log, terminate: () => terminate() });
	process.on("unhandledRejection", guard.onRejection);
	process.on("uncaughtException", guard.onException);
	let runner: ReturnType<typeof createLifecycleRunner> | undefined;
	let server: ReturnType<typeof Bun.serve> | undefined;
	// Resolves to true when every step succeeded. A failing step never skips the later ones.
	let stopping: Promise<boolean> | null = null;
	const gate = createStartupGate();
	const shutdown = () =>
		(stopping ??= (async () => {
			log.info("server.shutdown_started");
			// Let the startup step in flight finish before anything closes.
			await gate.settled();
			const ok = runner ? await runner.closeAll(SHUTDOWN_DEADLINE_MS) : true;
			log.info("server.shutdown_completed", { reason: ok ? "ok" : "failed" });
			return ok;
		})());
	// The process-level deadline backs up the runner's own, which normally fires first.
	terminate = createTerminator({
		shutdown,
		exit: (code) => process.exit(code),
		log,
		deadlineMs: PROCESS_SHUTDOWN_DEADLINE_MS,
	});
	for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
		process.on(signal, () => terminate());
	log.info("server.starting");
	try {
		if (config.host !== "127.0.0.1" && config.host !== "localhost")
			throw new Error("loopback_host_required");
		const token = resolveApiToken({
			EUMENES_API_TOKEN: config.apiToken,
			EUMENES_DB: config.dbPath,
			EUMENES_KEY_DIR: config.env.EUMENES_KEY_DIR,
		});
		const services = await gate.step(async () => {
			const built = await buildServices(config);
			runner = createLifecycleRunner(
				createLifecycles(built, {
					name: "http",
					close: () => server?.stop(true),
				}),
			);
			return built;
		});
		if (stopping) return;
		const active = runner as ReturnType<typeof createLifecycleRunner>;
		log.info("server.recovery_started");
		await gate.step(() => active.recoverAll());
		if (stopping) return;
		log.info("server.recovery_completed");
		await gate.step(() => active.startAll());
		if (stopping) return;
		const app = createApp({
			token,
			origin: config.origin,
			modules: appModules(appServices(services)),
		});
		await gate.step(() => {
			try {
				server = Bun.serve({
					hostname: config.host,
					port: config.port,
					idleTimeout: 60,
					fetch: app.fetch,
				});
			} catch (error) {
				if ((error as { code?: unknown } | null)?.code === "EADDRINUSE")
					throw new Error("port_in_use");
				throw error;
			}
		});
		if (stopping || !server) return;
		log.info("server.listening", { port: (server as { port: number }).port });
		// Probe once so the UI reports a real result before the first message.
		void services.inference.connect().then(
			() =>
				log.info("larm.probe_completed", {
					status: services.inference.status().state,
				}),
			(error) =>
				log.warn(
					"larm.probe_failed",
					{ status: services.inference.status().state },
					error,
				),
		);
	} catch (error) {
		// A failure caused by an in-progress shutdown is left to the terminator.
		if (stopping) return;
		await shutdown();
		throw error;
	}
}

/**
 * Startup failure messages that are stable codes and carry no secret. Anything
 * else (OS errors, paths, provider text) collapses to `startup_failed`.
 */
const SAFE_STARTUP_CODES = [
	/^config_invalid:[A-Z0-9_]+$/,
	/^migration_[a-z_]+:[A-Za-z0-9/._-]{1,120}$/,
	/^migration_[a-z_]+$/,
	/^(database_writer_owned|database_integrity_check_failed|world_cursor_secret_invalid|api_token_file_invalid|loopback_host_required|port_in_use)$/,
	/^secret_key_[a-z_]+$/,
];

/** The stable, non-sensitive reason code of a startup failure. */
export function startupFailureReason(error: unknown): string {
	const message = error instanceof Error ? error.message : undefined;
	if (message === "EUMENES_API_TOKEN must be at least 24 characters")
		return "api_token_too_short";
	if (
		message &&
		!message.includes("..") &&
		SAFE_STARTUP_CODES.some((p) => p.test(message))
	)
		return message;
	return "startup_failed";
}

// Importing this module only defines functions; the process starts when it is the entry point.
if (import.meta.main) {
	await main().catch((error) => {
		const reason = startupFailureReason(error);
		log.error("server.startup_failed", { reason }, error);
		process.stderr.write(`[eumenes] startup failed: ${reason}\n`);
		process.exit(1);
	});
}
