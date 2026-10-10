import { createServer } from "node:net";
import { resolve } from "node:path";
import { resolveApiToken } from "../api/infrastructure/auth-config";
import { PROCESS_SHUTDOWN_DEADLINE_MS } from "../api/infrastructure/shutdown";

const root = resolve(import.meta.dir, "..");
// Vite needs no provider credentials (LARM token etc.); pass only this allowlist.
const viteEnvKeys = [
	"PATH",
	"HOME",
	"TMPDIR",
	"LANG",
	"TERM",
	"NODE_ENV",
	"EUMENES_ORIGIN",
	"EUMENES_PROXY_URL",
	"EUMENES_DB",
	"EUMENES_KEY_DIR",
	"EUMENES_VITE_CACHE_DIR",
] as const;
function viteEnv(source: Record<string, string | undefined>, apiToken: string) {
	const picked: Record<string, string> = {};
	for (const key of viteEnvKeys) {
		const value = source[key];
		if (value !== undefined) picked[key] = value;
	}
	return { ...picked, EUMENES_API_TOKEN: apiToken };
}
type Child = ReturnType<typeof Bun.spawn>;
const API_KILL_GRACE_MS = PROCESS_SHUTDOWN_DEADLINE_MS + 1_000;
const WEB_KILL_GRACE_MS = 12_000;
type Managed = { child: Child; graceMs: number };

/** Same rule as config.ts: empty or whitespace-only means unset. */
const envValue = (name: string) => process.env[name]?.trim() || undefined;

async function available(host: string, port: number) {
	const probe = createServer();
	await new Promise<void>((resolve, reject) => {
		probe.once("error", reject);
		probe.listen(port, host, () =>
			probe.close((error) => (error ? reject(error) : resolve())),
		);
	});
}

async function ready(url: string, token: string, signal: AbortSignal) {
	const deadline = Date.now() + 30_000;
	while (!signal.aborted && Date.now() < deadline) {
		try {
			const response = await fetch(`${url}/api/status`, {
				headers: { Authorization: `Bearer ${token}` },
				signal: AbortSignal.any([signal, AbortSignal.timeout(500)]),
			});
			const body = (await response.json()) as { service?: string };
			if (response.ok && body.service === "eumenes") return;
		} catch {
			// The API is still starting; its exit is monitored separately.
		}
		await Bun.sleep(100);
	}
	signal.throwIfAborted();
	throw new Error("API startup timed out");
}

async function stop(children: Managed[]) {
	const timers: ReturnType<typeof setTimeout>[] = [];
	for (const { child, graceMs } of children) {
		if (child.exitCode === null) child.kill("SIGTERM");
		timers.push(
			setTimeout(() => {
				if (child.exitCode === null) child.kill("SIGKILL");
			}, graceMs),
		);
	}
	try {
		await Promise.all(children.map(({ child }) => child.exited));
	} finally {
		for (const timer of timers) clearTimeout(timer);
	}
}

async function main() {
	const children: Managed[] = [];
	const lifetime = new AbortController();
	const cancel = () => lifetime.abort();
	process.on("SIGINT", cancel);
	process.on("SIGTERM", cancel);
	const cancelled = new Promise<void>((resolve) =>
		lifetime.signal.addEventListener("abort", () => resolve(), { once: true }),
	);
	try {
		const webArgs = process.argv.slice(2).filter((arg) => arg !== "--");
		let webPort = 5173;
		let webHost = "127.0.0.1";
		for (let i = 0; i < webArgs.length; i++) {
			if (webArgs[i] === "--port") webPort = Number(webArgs[++i]);
			else if (webArgs[i]!.startsWith("--port="))
				webPort = Number(webArgs[i]!.slice("--port=".length));
			else if (webArgs[i] === "--host") {
				const selectedHost = webArgs[++i];
				if (!selectedHost || selectedHost.startsWith("-"))
					throw new Error("loopback_host_required");
				webHost = selectedHost;
			} else if (webArgs[i]!.startsWith("--host="))
				webHost = webArgs[i]!.slice("--host=".length);
		}
		if (!["127.0.0.1", "localhost"].includes(webHost))
			throw new Error("loopback_host_required");
		if (!Number.isInteger(webPort) || webPort < 1 || webPort > 65535)
			throw new Error("Vite port must be between 1 and 65535");
		const env = {
			...process.env,
			EUMENES_ORIGIN:
				envValue("EUMENES_ORIGIN") ?? `http://${webHost}:${webPort}`,
		};
		const token = resolveApiToken(process.env);
		const host = envValue("EUMENES_HOST") ?? "127.0.0.1";
		const port = Number(envValue("EUMENES_PORT") ?? 8787);
		if (!["127.0.0.1", "localhost"].includes(host))
			throw new Error("loopback_host_required");
		if (!Number.isInteger(port) || port < 1 || port > 65535)
			throw new Error("EUMENES_PORT must be between 1 and 65535");
		const url = `http://${host}:${port}`;
		try {
			await available(host, port);
		} catch {
			throw new Error(
				`API port ${port} is already in use. Stop the existing server before running bun run dev.`,
			);
		}
		if (lifetime.signal.aborted) return 0;
		const api = Bun.spawn([process.execPath, "api/application/server.ts"], {
			cwd: root,
			env,
			stdin: "inherit",
			stdout: "inherit",
			stderr: "inherit",
		});
		children.push({ child: api, graceMs: API_KILL_GRACE_MS });
		await Promise.race([
			ready(url, token, lifetime.signal),
			api.exited.then((code) => {
				throw new Error(`API stopped during startup (exit ${code})`);
			}),
		]);
		if (lifetime.signal.aborted) return 0;
		const node = Bun.which("node");
		if (!node) throw new Error("Node.js is required to start Vite");
		const web = Bun.spawn(
			[
				node,
				"node_modules/vite/bin/vite.js",
				"--host",
				"127.0.0.1",
				"--strictPort",
				...webArgs,
			],
			{
				cwd: root,
				env: viteEnv({ ...env, EUMENES_PROXY_URL: url }, token),
				stdin: "inherit",
				stdout: "inherit",
				stderr: "inherit",
			},
		);
		children.push({ child: web, graceMs: WEB_KILL_GRACE_MS });
		const exited = await Promise.race([
			cancelled.then(() => null),
			api.exited.then((code) => ({ name: "API", code })),
			web.exited.then((code) => ({ name: "Vite", code })),
		]);
		if (lifetime.signal.aborted || !exited) return 0;
		console.error(`[dev] ${exited.name} stopped (exit ${exited.code}).`);
		return exited.code || 1;
	} catch (error) {
		if (lifetime.signal.aborted) return 0;
		console.error(
			`[dev] ${error instanceof Error ? error.message : "Startup failed"}`,
		);
		return 1;
	} finally {
		lifetime.abort();
		await stop(children);
		process.off("SIGINT", cancel);
		process.off("SIGTERM", cancel);
	}
}

process.exitCode = await main();
