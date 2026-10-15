import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SdkService } from "../src/sdk-service";
import { serveSdk } from "../src/sdk-server";
import { sdkRunnerClient } from "../src/sdk-client";
import { atomicWrite } from "../src/storage";
import type { SdkReceipt, SdkSpec } from "../src/sdk-contracts";
import type { SdkEngine } from "../src/sdk-engine";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
function fixture() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "sdk-runner-")));
	roots.push(root);
	const workspace = join(root, "workspace");
	mkdirSync(workspace);
	return {
		root: join(root, "spool"),
		workspaces: { fixture: workspace, alias: workspace },
		protectedPaths: [],
	};
}
function spec(executionId = "first"): SdkSpec {
	return {
		protocol: "eumenes-codex-sdk/1",
		executionId,
		ownerId: "card",
		workspaceId: "fixture",
		prompt: "fixture task",
		deadline: new Date(Date.now() + 60_000).toISOString(),
	};
}
const report = {
	outcome: "done" as const,
	summary: "verified",
	verification: [],
	files: [],
	unconfirmed: [],
	blocker: "",
};
async function settled(service: SdkService, id: string) {
	for (let i = 0; i < 100; i++) {
		const receipt = service.request({
			operation: "inspect",
			executionId: id,
		}) as SdkReceipt;
		if (
			["succeeded", "blocked", "failed", "cancelled", "unknown"].includes(
				receipt.state,
			)
		)
			return receipt;
		await Bun.sleep(5);
	}
	throw new Error("fixture_timeout");
}

test("durable acceptance replay never repeats SDK and events replay by cursor after restart", async () => {
	let calls = 0;
	const config = fixture();
	const engine: SdkEngine = async ({ onThread, onActivity }) => {
		calls++;
		onThread("saved-thread");
		onActivity({ type: "turn.started" });
		onActivity({ type: "turn.completed" });
		return { report, managedExecutionStopped: true };
	};
	let service = new SdkService(config, engine);
	const input = spec();
	const accepted = service.request({
		operation: "start",
		spec: input,
	}) as SdkReceipt;
	service.request({ operation: "start", spec: input });
	const done = await settled(service, input.executionId);
	expect(done.state).toBe("succeeded");
	expect(done.workspaceHeld).toBe(false);
	expect(done.workspaceReleaseConfirmed).toBe(false);
	expect(calls).toBe(1);
	await service.close();
	service = new SdkService(config, engine);
	try {
		const recovered = service.request({
			operation: "recover",
			executionId: input.executionId,
		}) as SdkReceipt;
		expect(recovered.epoch).toBe(accepted.epoch);
		expect(recovered.threadId).toBe("saved-thread");
		service.request({ operation: "start", spec: input });
		expect(calls).toBe(1);
		const replay = service.request({
			operation: "events",
			executionId: input.executionId,
			after: 1,
		}) as { events: { seq: number }[] };
		expect(replay.events.map((e) => e.seq)).toEqual([2]);
		expect(() =>
			service.request({
				operation: "start",
				spec: { ...input, prompt: "changed" },
			}),
		).toThrow("sdk_idempotency_conflict");
	} finally {
		await service.close();
	}
});

test("workspace aliases stay exclusive during execution and are released after managed termination", async () => {
	let finish: () => void = () => {};
	const service = new SdkService(fixture(), async () => {
		await new Promise<void>((resolve) => {
			finish = resolve;
		});
		return { report, managedExecutionStopped: true };
	});
	try {
		service.request({ operation: "start", spec: spec() });
		await Bun.sleep(5);
		expect(() =>
			service.request({
				operation: "start",
				spec: { ...spec("other"), workspaceId: "alias", ownerId: "other-card" },
			}),
		).toThrow("sdk_workspace_busy");
		finish();
		expect((await settled(service, "first")).workspaceHeld).toBe(false);
		service.request({
			operation: "release",
			executionId: "first",
			operationId: "release",
		});
		service.request({
			operation: "start",
			spec: { ...spec("other"), workspaceId: "alias", ownerId: "other-card" },
		});
		await Bun.sleep(5);
		finish();
		await settled(service, "other");
	} finally {
		finish();
		await service.close();
	}
});

test("only explicit same-owner continuation resumes its native thread", async () => {
	const threads: (string | undefined)[] = [];
	const service = new SdkService(fixture(), async ({ spec, onThread }) => {
		threads.push(spec.threadId);
		onThread("native-session");
		return { report, managedExecutionStopped: true };
	});
	try {
		service.request({ operation: "start", spec: spec() });
		await settled(service, "first");
		const next = {
			...spec("second"),
			continuationOf: "first",
			threadId: "native-session",
		};
		expect(() =>
			service.request({
				operation: "start",
				spec: { ...next, ownerId: "wrong" },
			}),
		).toThrow("sdk_continuation_unavailable");
		service.request({ operation: "start", spec: next });
		await settled(service, "second");
		expect(threads).toEqual([undefined, "native-session"]);
		expect(
			(
				service.request({
					operation: "inspect",
					executionId: "first",
				}) as SdkReceipt
			).workspaceHeld,
		).toBe(false);
	} finally {
		await service.close();
	}
});

test("crash after durable start intent restores unknown without SDK replay or PID signalling", async () => {
	const config = fixture();
	let calls = 0;
	let service = new SdkService(config, async () => {
		calls++;
		return { report, managedExecutionStopped: true };
	});
	const input = spec();
	service.store.create(input, "old-epoch");
	atomicWrite(
		join(service.store.path(input.executionId), "start-intent.json"),
		{ epoch: "old-epoch" },
	);
	await service.close();
	service = new SdkService(config, async () => {
		calls++;
		return { report, managedExecutionStopped: true };
	});
	try {
		const receipt = service.request({
			operation: "recover",
			executionId: input.executionId,
		}) as SdkReceipt;
		expect(receipt.state).toBe("unknown");
		expect(receipt.managedExecutionStopped).toBe(false);
		expect(receipt.workspaceReleaseConfirmed).toBe(false);
		service.request({ operation: "start", spec: input });
		expect(calls).toBe(0);
		expect(() =>
			service.request({
				operation: "release",
				executionId: input.executionId,
				operationId: "release",
			}),
		).toThrow("sdk_release_unconfirmed");
	} finally {
		await service.close();
	}
});

test("private socket reconnect preserves execution and stop receipt has no repeat effect", async () => {
	let calls = 0;
	const service = new SdkService(fixture(), async ({ onActivity, signal }) => {
		calls++;
		onActivity({ type: "turn.started" });
		await new Promise<void>((resolve) =>
			signal.addEventListener("abort", () => resolve(), { once: true }),
		);
		return { failure: "sdk_aborted", managedExecutionStopped: true };
	});
	const host = await serveSdk(service);
	try {
		const input = spec();
		const accepted = await sdkRunnerClient(host.socket).start(input);
		const reconnected = await sdkRunnerClient(host.socket).start(input);
		expect(reconnected.epoch).toBe(accepted.epoch);
		await sdkRunnerClient(host.socket).stop(input.executionId, "stop-1");
		await sdkRunnerClient(host.socket).stop(input.executionId, "stop-1");
		expect((await settled(service, input.executionId)).state).toBe("cancelled");
		expect(calls).toBe(1);
	} finally {
		await host.close();
	}
});

test("runner root has a single owner and unregistered paths / expired requests are rejected", async () => {
	const config = fixture();
	const service = new SdkService(config, async () => ({
		report,
		managedExecutionStopped: true,
	}));
	try {
		expect(() => new SdkService(config)).toThrow("runner_busy");
		expect(() =>
			service.request({
				operation: "start",
				spec: { ...spec(), workspaceId: "unknown" },
			}),
		).toThrow("sdk_workspace_unregistered");
		expect(() =>
			service.request({
				operation: "start",
				spec: { ...spec(), deadline: "2000-01-01T00:00:00.000Z" },
			}),
		).toThrow("sdk_deadline_invalid");
	} finally {
		await service.close();
	}
});

test("explicit replacement starts a fresh native thread while retaining the same workspace owner", async () => {
	const threads: (string | undefined)[] = [];
	const service = new SdkService(fixture(), async ({ spec, onThread }) => {
		threads.push(spec.threadId);
		onThread(`thread-${threads.length}`);
		return { report, managedExecutionStopped: true };
	});
	try {
		service.request({ operation: "start", spec: spec() });
		await settled(service, "first");
		service.request({
			operation: "start",
			spec: { ...spec("fresh"), replacementOf: "first" },
		});
		await settled(service, "fresh");
		expect(threads).toEqual([undefined, undefined]);
		expect(
			(
				service.request({
					operation: "inspect",
					executionId: "fresh",
				}) as SdkReceipt
			).threadId,
		).toBe("thread-2");
	} finally {
		await service.close();
	}
});

test("a crash in multi-file workspace handoff blocks that workspace while records remain inspectable", async () => {
	const config = fixture();
	let service = new SdkService(config, async () => ({
		report,
		managedExecutionStopped: true,
	}));
	service.store.create(spec(), "old-epoch");
	service.store.create(
		{ ...spec("second"), replacementOf: "first" },
		"old-epoch",
	);
	for (const id of ["first", "second"])
		atomicWrite(join(service.store.path(id), "start-intent.json"), {
			epoch: "old-epoch",
		});
	await service.close();
	service = new SdkService(config, async () => ({
		report,
		managedExecutionStopped: true,
	}));
	try {
		expect(
			(
				service.request({
					operation: "inspect",
					executionId: "first",
				}) as SdkReceipt
			).state,
		).toBe("unknown");
		expect(
			(
				service.request({
					operation: "inspect",
					executionId: "second",
				}) as SdkReceipt
			).workspaceReleaseConfirmed,
		).toBe(false);
		expect(() =>
			service.request({ operation: "start", spec: spec("third") }),
		).toThrow("sdk_workspace_busy");
	} finally {
		await service.close();
	}
});
