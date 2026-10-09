import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { join } from "node:path";
import { fixture, until } from "./support";
import { createRunner, publishSpec } from "../src/core";
import { connectRunner } from "../src/client";
import { toolInputs } from "../src/contracts";

test("SDK tools/list is fixed; unknown tool, unknown fields and protocol mismatch are rejected", async () => {
	const f = fixture();
	const client = new Client({ name: "fixture", version: "1" });
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [join(import.meta.dir, "fixture-server.ts")],
		env: { PATH: "/usr/bin:/bin", EUMENES_CODING_RUNNER_CONFIG: f.configPath },
		stderr: "ignore",
	});
	try {
		await client.connect(transport);
		const listed = await client.listTools();
		expect(listed.tools.map((t) => t.name).sort()).toEqual(
			Object.keys(toolInputs).sort(),
		);
		const unknown = await client.callTool({
			name: "arbitrary_shell",
			arguments: { command: "echo unsafe" },
		});
		expect(unknown.isError).toBe(true);
		const invalid = await client.callTool({
			name: "runner.probe",
			arguments: {
				version: "eumenes-coding/1",
				workspaceId: "fixture",
				executable: "/bin/sh",
			},
		});
		expect(invalid.isError).toBe(true);
		const wrongVersion = await client.callTool({
			name: "runner.probe",
			arguments: { version: "future/2", workspaceId: "fixture" },
		});
		expect(wrongVersion.isError).toBe(true);
	} finally {
		await client.close();
		f.close();
	}
});
test("RPC cancellation is not CLI stop; inspect retains the execution identity", async () => {
	const f = fixture();
	const runner = createRunner(f.configPath, true);
	const spec = f.spec("long");
	publishSpec(f.config, "spec", spec);
	const client = await connectRunner({
		executable: process.execPath,
		serverPath: join(import.meta.dir, "fixture-server.ts"),
		configPath: f.configPath,
	});
	try {
		await client.start("spec", spec);
		await until(
			() => client.inspect(spec.executionId, 0, 100),
			(r) => r.receipt.state === "running",
		);
		const controller = new AbortController();
		controller.abort();
		await expect(
			client.inspect(spec.executionId, 0, 100, false, controller.signal),
		).rejects.toThrow("runner_rpc_cancelled");
		expect(runner.inspect(spec.executionId, 0, 100, false).receipt.state).toBe(
			"running",
		);
		await client.stop(spec.executionId, 1, "stop", "cancel");
		await until(
			() => runner.inspect(spec.executionId, 0, 100, false),
			(r) => r.receipt.childrenStopped,
		);
	} finally {
		await client.close();
		f.close();
	}
});
test("continue needs the exact completed session and a fresh operation; revocation forbids reuse", async () => {
	const f = fixture();
	const runner = createRunner(f.configPath, true);
	const first = f.spec();
	publishSpec(f.config, "first", first);
	try {
		await runner.start("first", first.operationId, first.executionId, false);
		const ended = await until(
			() => runner.inspect(first.executionId, 0, 100, false),
			(r) => r.receipt.childrenStopped,
		);
		const next = {
			...f.spec(),
			kind: "continue" as const,
			sessionId: ended.receipt.sessionId,
			previousExecutionId: first.executionId,
			deadlineAt: first.deadlineAt,
		};
		const wrong = { ...next, sessionId: crypto.randomUUID() };
		publishSpec(f.config, "wrong", wrong);
		await expect(
			runner.start("wrong", wrong.operationId, wrong.executionId, true),
		).rejects.toThrow("runner_session_busy_or_stale");
		publishSpec(f.config, "next", next);
		await runner.start("next", next.operationId, next.executionId, true);
		const resumed = await until(
			() => runner.inspect(next.executionId, 0, 100, false),
			(r) => r.receipt.childrenStopped,
		);
		expect(resumed.receipt.exitCode).toBe(0);
		expect(resumed.receipt.evidenceComplete).toBe(true);
		expect(resumed.receipt.turnFinished).toBe(true);
		expect(resumed.receipt.sessionId).toBe(ended.receipt.sessionId);
		runner.stop(next.executionId, 1, "cancel", "cancel");
		const revoked = {
			...f.spec(),
			kind: "continue" as const,
			sessionId: resumed.receipt.sessionId,
			previousExecutionId: next.executionId,
			deadlineAt: next.deadlineAt,
		};
		publishSpec(f.config, "revoked", revoked);
		await expect(
			runner.start("revoked", revoked.operationId, revoked.executionId, true),
		).rejects.toThrow("runner_session_revoked");
	} finally {
		f.close();
	}
});
