import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
async function port() {
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () => new Response(),
	});
	const selected = server.port!;
	await server.stop(true);
	return selected;
}
function launch(
	apiPort: number,
	webPort: number,
	webHost = "127.0.0.1",
	webArgs?: string[],
) {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-dev-"));
	const child = spawn(
		process.execPath,
		[
			"run",
			"dev",
			"--",
			...(webArgs ??
				(webHost === "127.0.0.1"
					? ["--port", String(webPort)]
					: [`--port=${webPort}`, "--host=localhost"])),
		],
		{
			cwd: root,
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				PATH: process.env.PATH,
				EUMENES_API_TOKEN: "fixture-api-token-long-enough",
				EUMENES_DB: join(dir, "db.sqlite3"),
				EUMENES_PORT: String(apiPort),
				EUMENES_HOST: "127.0.0.1",
				// Combined dev must use the API it launches, not a stale proxy target.
				EUMENES_PROXY_URL: "http://127.0.0.1:1",
				EUMENES_SECRET_KEY: "",
				LARM_API_TOKEN: "",
				LARM_CONTROL_TOKEN: "",
				LARM_BASE_URL: "http://127.0.0.1:1",
				LARM_PROFILE: "SAAA-gemma4-26b",
				LARM_AUDIENCE: "same-host",
				EUMENES_TTS_VOICE: "",
			},
		},
	);
	let output = "";
	child.stdout.on("data", (bytes) => {
		output += String(bytes);
	});
	child.stderr.on("data", (bytes) => {
		output += String(bytes);
	});
	const exited = new Promise<number | null>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (code) => resolve(code));
	});
	function signal(value: "SIGINT" | "SIGTERM" | "SIGKILL") {
		try {
			process.kill(-child.pid!, value);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
		}
	}
	return {
		exited,
		signal,
		output: () => output,
		async close() {
			signal("SIGTERM");
			const timeout = setTimeout(() => signal("SIGKILL"), 5000);
			try {
				await exited;
			} finally {
				clearTimeout(timeout);
				rmSync(dir, { recursive: true, force: true });
			}
		},
	};
}
async function get(url: string) {
	return fetch(url, { signal: AbortSignal.timeout(500) }).catch(() => null);
}

test.each(["127.0.0.1", "localhost"])(
	"bun run dev serves browser requests on %s and Ctrl+C releases both ports",
	async (webHost) => {
		const apiPort = await port(),
			webPort = await port();
		const dev = launch(apiPort, webPort, webHost);
		try {
			const url = `http://${webHost}:${webPort}/api/status`;
			let response: Response | null = null;
			for (let i = 0; i < 100; i++) {
				response = await get(url);
				if (response?.ok) break;
				await Bun.sleep(50);
			}
			expect(response?.status, dev.output()).toBe(200);
			expect(await response!.json()).toEqual({
				service: "eumenes",
				larm: { state: "unconfigured", capabilities: [] },
			});
			const browserResponse = await fetch(url, {
				headers: { Origin: `http://${webHost}:${webPort}` },
				signal: AbortSignal.timeout(1000),
			});
			expect(browserResponse.status, await browserResponse.text()).toBe(200);
			const foreignResponse = await fetch(url, {
				headers: { Origin: "http://foreign.invalid" },
				signal: AbortSignal.timeout(1000),
			});
			expect(foreignResponse.status).toBe(403);
			expect(dev.output()).not.toContain("ECONNREFUSED");
			dev.signal("SIGINT");
			await dev.exited;
			expect(await get(`http://127.0.0.1:${apiPort}/api/status`)).toBeNull();
			expect(await get(url)).toBeNull();
		} finally {
			await dev.close();
		}
	},
	15000,
);

for (const args of [["--host"], ["--host", "0.0.0.0"]]) {
	test(`dev refuses ${args.join(" ")} before exposing the authenticated proxy`, async () => {
		const apiPort = await port(),
			webPort = await port();
		const dev = launch(apiPort, webPort, "127.0.0.1", [
			"--port",
			String(webPort),
			...args,
		]);
		try {
			expect(await dev.exited).toBe(1);
			expect(dev.output()).toContain("loopback_host_required");
			expect(await get(`http://127.0.0.1:${apiPort}/api/status`)).toBeNull();
			expect(await get(`http://127.0.0.1:${webPort}/`)).toBeNull();
		} finally {
			await dev.close();
		}
	}, 10000);
}

test("occupied API port is reported without starting Web or stopping its owner", async () => {
	const owner = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () => new Response("existing API"),
	});
	const webPort = await port();
	const dev = launch(owner.port!, webPort);
	try {
		expect(await dev.exited).toBe(1);
		expect(dev.output()).toContain("already in use");
		expect(await get(`http://127.0.0.1:${webPort}/`)).toBeNull();
		expect(await (await get(`http://127.0.0.1:${owner.port}/`))!.text()).toBe(
			"existing API",
		);
	} finally {
		await dev.close();
		await owner.stop(true);
	}
}, 10000);

test("Vite port failure stops the API instead of silently moving Web to another port", async () => {
	const owner = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () => new Response("existing Web"),
	});
	const apiPort = await port();
	const dev = launch(apiPort, owner.port!);
	try {
		expect(await dev.exited, dev.output()).toBe(1);
		expect(dev.output()).toContain("already in use");
		expect(await get(`http://127.0.0.1:${apiPort}/api/status`)).toBeNull();
		expect(await (await get(`http://127.0.0.1:${owner.port}/`))!.text()).toBe(
			"existing Web",
		);
	} finally {
		await dev.close();
		await owner.stop(true);
	}
}, 15000);
