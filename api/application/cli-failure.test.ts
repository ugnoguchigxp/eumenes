import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { ApiConnectionError, ApiError } from "../../client";
import { cliFailure } from "../../cli/failure";

for (const [error, exitCode] of [
	[new ApiError(401, "unauthorized", "request-trace"), 2],
	[new ApiError(409, "conflict", "request-trace"), 3],
	[new ApiConnectionError(), 5],
] as const) {
	test(`shared CLI failure reports ${error.message} with exit code ${exitCode}`, () => {
		const result = cliFailure(error);
		expect(result.exitCode).toBe(exitCode);
		if (error instanceof ApiError)
			expect(result.lines).toEqual([
				error.message,
				"API request ID: request-trace",
			]);
	});
}

test("shared CLI failure preserves the caller's timeout or processing exit code", () => {
	expect(cliFailure(new DOMException("timeout", "TimeoutError"), 4)).toEqual({
		exitCode: 4,
		lines: ["timeout"],
	});
	expect(cliFailure(new Error("processing_failed"), 3).exitCode).toBe(3);
	expect(cliFailure(new Error("invalid_argument")).exitCode).toBe(2);
});

for (const command of ["status", "chat"]) {
	test(`actual ${command} CLI process reports connection failure without starting a server or corrupting stdout`, async () => {
		const child = Bun.spawn(
			[process.execPath, "cli/index.ts", command, "--json"],
			{
				cwd: resolve(import.meta.dir, "../.."),
				env: {
					PATH: process.env.PATH,
					EUMENES_API_TOKEN: "fixture-api-token-long-enough",
					EUMENES_URL: "http://127.0.0.1:0",
				},
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const [code, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		expect(code).toBe(5);
		expect(stdout).toBe("");
		expect(stderr).toContain("Cannot connect to http://127.0.0.1:0");
	});
}
