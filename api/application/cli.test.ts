import { expect, test } from "bun:test";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
async function cli(args: string[], url: string) {
	const child = Bun.spawn([process.execPath, "cli/index.ts", ...args], {
		cwd: root,
		env: {
			PATH: process.env.PATH,
			EUMENES_API_TOKEN: "fixture-api-token-long-enough",
			EUMENES_URL: url,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [code, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	return { code, stdout, stderr };
}

test("CLI connection failure has the documented exit code and stdout stays empty", async () => {
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () => new Response(),
	});
	const url = `http://127.0.0.1:${server.port}`;
	await server.stop(true);
	const result = await cli(["status", "--json"], url);
	expect(result.code).toBe(5);
	expect(result.stdout).toBe("");
	expect(result.stderr).toContain("Cannot connect");
});

test("CLI rejects missing or invalid request IDs before submitting a new run", async () => {
	let submissions = 0;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () => {
			submissions++;
			return Response.json({});
		},
	});
	try {
		for (const id of [[], ["not-a-uuid"]]) {
			const result = await cli(
				["send", "hello", "--request-id", ...id],
				`http://127.0.0.1:${server.port}`,
			);
			expect(result.code).toBe(2);
			expect(result.stdout).toBe("");
		}
		expect(submissions).toBe(0);
	} finally {
		await server.stop(true);
	}
});

test("CLI reports invalid API configuration as an argument error", async () => {
	const result = await cli(["status", "--json"], "http://example.test");
	expect(result.code).toBe(2);
	expect(result.stdout).toBe("");
	expect(result.stderr).toContain("loopback_api_required");
});

for (const [scheme, userInfo] of [
	["ftp", ""],
	["http", "fixture-user:fixture-password@"],
]) {
	test(`CLI rejects invalid ${scheme} API URL before requesting or exposing credentials`, async () => {
		let requests = 0;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => {
				requests++;
				return Response.json({
					service: "eumenes",
					larm: { state: "unconfigured", capabilities: [] },
				});
			},
		});
		try {
			const result = await cli(
				["status", "--json"],
				`${scheme}://${userInfo}127.0.0.1:${server.port}`,
			);
			expect(result.code).toBe(2);
			expect(result.stdout).toBe("");
			expect(result.stderr).toContain("invalid_api_url");
			expect(result.stderr).not.toContain("fixture-password");
			expect(requests).toBe(0);
		} finally {
			await server.stop(true);
		}
	});
}

test("web CLI uses authenticated API, fresh search, explicit stable retention and result polling", async () => {
	const submitted: Record<string, unknown>[] = [];
	const requests: { path: string; method: string }[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(req) {
			expect(req.headers.get("authorization")).toBe(
				"Bearer fixture-api-token-long-enough",
			);
			const path = new URL(req.url).pathname;
			requests.push({ path, method: req.method });
			if (path === "/api/web-research/runs" && req.method === "POST") {
				submitted.push((await req.json()) as Record<string, unknown>);
				return Response.json({ id: "fixture-run", status: "queued" });
			}
			if (path.endsWith("/cancel"))
				return Response.json({ id: "fixture-run", status: "cancelled" });
			if (path.endsWith("/cache/status"))
				return Response.json({ enabled: true, entries: 0 });
			if (path.endsWith("/cache/clear"))
				return Response.json({ cleared: true });
			return Response.json({
				id: "fixture-run",
				status: "completed",
				result: { cache: "bypass" },
			});
		},
	});
	const url = `http://127.0.0.1:${server.port}`;
	try {
		for (const args of [
			[
				"web",
				"search",
				"Bun documentation",
				"--read-pages",
				"--wait",
				"--json",
			],
			["web", "read", "https://example.com/", "--stable", "--json"],
			["web", "read", "https://example.com/", "--stable", "--fresh", "--json"],
			["web", "cancel", "fixture-run", "--json"],
			["web", "cache", "--json"],
			["web", "clear", "--json"],
		]) {
			const result = await cli(args, url);
			expect(result.code).toBe(0);
			expect(result.stderr).toBe("");
			expect(JSON.parse(result.stdout)).toBeObject();
		}
		expect(submitted[0]).toMatchObject({
			operation: "lookup",
			query: "Bun documentation",
			readPages: 3,
			freshness: "live",
		});
		expect(submitted[1]).toMatchObject({
			operation: "read",
			retention: "stable",
			freshness: "normal",
		});
		expect(submitted[2]).toMatchObject({
			operation: "read",
			retention: "stable",
			freshness: "live",
		});
		expect(requests).toContainEqual({
			path: "/api/web-research/runs/fixture-run",
			method: "GET",
		});
		expect(requests).toContainEqual({
			path: "/api/web-research/cache/clear",
			method: "POST",
		});
	} finally {
		await server.stop(true);
	}
});

test("web wait distinguishes cancellation, failure and expired delivery", async () => {
	let terminal: Record<string, unknown> = { status: "cancelled" };
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: (req) =>
			Response.json(
				req.method === "POST"
					? { id: "fixture-run", status: "queued" }
					: { id: "fixture-run", ...terminal },
			),
	});
	try {
		for (const [state, expected] of [
			[{ status: "cancelled" }, 4],
			[{ status: "failed" }, 3],
			[{ status: "completed", resultExpired: true }, 4],
		] as const) {
			terminal = state;
			expect(
				(
					await cli(
						["web", "search", "fixture", "--wait", "--json"],
						`http://127.0.0.1:${server.port}`,
					)
				).code,
			).toBe(expected);
		}
	} finally {
		await server.stop(true);
	}
});

test("web SIGINT exits with unconfirmed cancellation even if the API never confirms it", async () => {
	let polls = 0,
		cancels = 0;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: (req) => {
			if (new URL(req.url).pathname.endsWith("/cancel")) cancels++;
			if (req.method === "GET") polls++;
			return Response.json({ id: "fixture-run", status: "queued" });
		},
	});
	const child = Bun.spawn(
		[
			process.execPath,
			"cli/index.ts",
			"web",
			"search",
			"fixture",
			"--wait",
			"--json",
		],
		{
			cwd: root,
			env: {
				PATH: process.env.PATH,
				EUMENES_API_TOKEN: "fixture-api-token-long-enough",
				EUMENES_URL: `http://127.0.0.1:${server.port}`,
			},
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	try {
		for (let i = 0; i < 100 && !polls; i++) await Bun.sleep(10);
		expect(polls).toBeGreaterThan(0);
		child.kill("SIGINT");
		const [code, output, error] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		expect(code).toBe(4);
		expect(output).toBe("");
		expect(error).toContain("outcome unconfirmed");
		expect(cancels).toBe(1);
	} finally {
		if (child.exitCode === null) child.kill();
		await server.stop(true);
	}
}, 2000);

test("SIGINT also cancels a web status request whose response never arrives", async () => {
	let polls = 0;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(req) {
			if (req.method === "GET") {
				polls++;
				return new Promise<Response>(() => {});
			}
			return Response.json({ id: "fixture-run", status: "queued" });
		},
	});
	const child = Bun.spawn(
		[
			process.execPath,
			"cli/index.ts",
			"web",
			"search",
			"fixture",
			"--wait",
			"--json",
		],
		{
			cwd: root,
			env: {
				PATH: process.env.PATH,
				EUMENES_API_TOKEN: "fixture-api-token-long-enough",
				EUMENES_URL: `http://127.0.0.1:${server.port}`,
			},
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	try {
		for (let i = 0; i < 100 && !polls; i++) await Bun.sleep(10);
		expect(polls).toBeGreaterThan(0);
		child.kill("SIGINT");
		const [code, error] = await Promise.all([
			child.exited,
			new Response(child.stderr).text(),
		]);
		expect(code).toBe(4);
		expect(error).toContain("outcome unconfirmed");
	} finally {
		if (child.exitCode === null) child.kill();
		await server.stop(true);
	}
}, 2000);
