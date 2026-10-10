import { type ChildProcess, spawn } from "node:child_process";
import { join } from "node:path";
import { createServer, type Server } from "node:net";

/** Sends `signal` to the whole process group of `child`; false when it is already gone. */
function signalGroup(child: ChildProcess, signal: NodeJS.Signals): boolean {
	if (child.pid === undefined) return false;
	try {
		process.kill(-child.pid, signal);
		return true;
	} catch {
		return false;
	}
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Bun child processes (API, LARM fixture, Vite) owned by one spec file.
 *
 * Children run as process-group leaders, so stopping them also stops what they
 * spawned (`bun run dev:web` forks Vite). Ports returned by `port()`/`ports()`
 * stay bound until the child that will listen on them is launched, which keeps
 * the window for another process to take the port as short as possible.
 */
export function createFixture() {
	const children = new Set<ChildProcess>();
	const held = new Map<number, Server>();

	// A crashed worker must not leave Vite behind.
	process.once("exit", () => {
		for (const child of children) signalGroup(child, "SIGKILL");
	});

	async function listen(): Promise<Server> {
		const server = createServer();
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolve);
		});
		return server;
	}
	const close = (server: Server) =>
		new Promise<void>((resolve) => server.close(() => resolve()));

	/** Reserves `count` distinct free ports; each stays bound until `release`d or launched with. */
	async function ports(count: number): Promise<number[]> {
		const servers: Server[] = [];
		try {
			for (let i = 0; i < count; i++) servers.push(await listen());
		} catch (error) {
			await Promise.all(servers.map(close));
			throw error;
		}
		return servers.map((server) => {
			const number = (server.address() as { port: number }).port;
			held.set(number, server);
			return number;
		});
	}
	async function port(): Promise<number> {
		return (await ports(1))[0]!;
	}
	/** Frees a reserved port so a child can bind it. */
	async function release(...numbers: number[]): Promise<void> {
		for (const number of numbers) {
			const server = held.get(number);
			held.delete(number);
			if (server) await close(server);
		}
	}

	/**
	 * Spawns `bun <args>` from the repository root as a process-group leader.
	 * `env` is merged over the parent environment. The reserved ports in
	 * `options.ports` are released immediately before the spawn.
	 */
	async function launch(
		args: string[],
		env: Record<string, string> = {},
		options: { ports?: number[] } = {},
	): Promise<ChildProcess> {
		await release(...(options.ports ?? []));
		const child = spawn("bun", args, {
			cwd: process.cwd(),
			env: { ...process.env, ...env },
			stdio: "ignore",
			detached: true,
		});
		children.add(child);
		return child;
	}

	/** Starts the Vite dev server on `webPort`, proxying `/api` to `apiPort`. */
	function launchWeb(options: {
		webPort: number;
		apiPort: number;
		token: string;
		cacheDir: string;
		env?: Record<string, string>;
	}): Promise<ChildProcess> {
		return launch(
			["run", "dev:web", "--port", String(options.webPort)],
			{
				EUMENES_PROXY_URL: `http://127.0.0.1:${options.apiPort}`,
				EUMENES_API_TOKEN: options.token,
				EUMENES_ORIGIN: `http://127.0.0.1:${options.webPort}`,
				EUMENES_VITE_CACHE_DIR: options.cacheDir,
				LARM_API_TOKEN: "",
				...options.env,
			},
			{ ports: [options.webPort] },
		);
	}

	/** Polls `check` every `intervalMs` until it returns true; throws `message` otherwise. */
	async function waitUntil(
		check: () => Promise<boolean>,
		options: { attempts?: number; intervalMs?: number; message: string },
	): Promise<void> {
		const attempts = options.attempts ?? 100;
		const intervalMs = options.intervalMs ?? 100;
		for (let i = 0; i < attempts; i++) {
			try {
				if (await check()) return;
			} catch {}
			await sleep(intervalMs);
		}
		throw new Error(options.message);
	}

	/** Waits until `url` answers with a non-5xx status. */
	function ready(url: string, attempts = 100): Promise<void> {
		return waitUntil(async () => (await fetch(url)).status < 500, {
			attempts,
			message: `server unavailable: ${url}`,
		});
	}

	/** Stops one child's process group: SIGTERM, then SIGKILL if it outlives `graceMs`. */
	async function stop(
		child: ChildProcess | undefined,
		graceMs = 5000,
	): Promise<void> {
		if (!child) return;
		children.delete(child);
		signalGroup(child, "SIGTERM");
		for (
			let waited = 0;
			waited < graceMs && child.exitCode === null;
			waited += 50
		)
			await sleep(50);
		// The leader may be gone while a forked Vite is still alive: kill the group anyway.
		signalGroup(child, "SIGKILL");
	}

	/** Stops every child (and what they forked) and frees any port still held. */
	async function stopAll(): Promise<void> {
		const all = [...children];
		children.clear();
		for (const child of all) signalGroup(child, "SIGTERM");
		await sleep(200);
		for (const child of all) signalGroup(child, "SIGKILL");
		await release(...held.keys());
	}

	/**
	 * Starts the fixture LARM, the real API and Vite used by the voice specs, and
	 * waits until the API reports LARM ready. Resolves with the three ports.
	 */
	async function startVoiceStack(options: { dir: string; token: string }) {
		const [apiPort, webPort, larmPort] = (await ports(3)) as [
			number,
			number,
			number,
		];
		await launch(
			["scripts/larm-fixture-server.ts"],
			{ LARM_FIXTURE_PORT: String(larmPort) },
			{ ports: [larmPort] },
		);
		await ready(`http://127.0.0.1:${larmPort}/v3/agent-profiles`);
		await launch(
			["api/application/server.ts"],
			{
				EUMENES_DB: join(options.dir, "test.sqlite3"),
				EUMENES_TOOLCHAIN_ENABLED: "0",
				EUMENES_LOG_FILE: join(options.dir, "logs/api.jsonl"),
				EUMENES_LOG_LEVEL: "debug",
				EUMENES_API_TOKEN: options.token,
				EUMENES_PORT: String(apiPort),
				EUMENES_ORIGIN: `http://127.0.0.1:${webPort}`,
				LARM_BASE_URL: `http://127.0.0.1:${larmPort}`,
				LARM_API_TOKEN: "fixture-control",
				LARM_CONTROL_TOKEN: "",
			},
			{ ports: [apiPort] },
		);
		await ready(`http://127.0.0.1:${apiPort}/api/status`);
		await waitUntil(
			async () => {
				const response = await fetch(`http://127.0.0.1:${apiPort}/api/status`, {
					headers: { Authorization: `Bearer ${options.token}` },
				});
				if (!response.ok) return false;
				return (await response.json()).larm.state === "ready";
			},
			{ attempts: 150, message: "larm_not_ready" },
		);
		await launchWeb({
			webPort,
			apiPort,
			token: options.token,
			cacheDir: join(options.dir, "vite-cache"),
			env: { LARM_API_TOKEN: "fixture-control", LARM_CONTROL_TOKEN: "" },
		});
		await ready(`http://127.0.0.1:${webPort}/`);
		return { apiPort, webPort, larmPort };
	}

	return {
		port,
		ports,
		release,
		launch,
		launchWeb,
		waitUntil,
		ready,
		stop,
		stopAll,
		startVoiceStack,
	};
}
export type Fixture = ReturnType<typeof createFixture>;
