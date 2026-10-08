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
