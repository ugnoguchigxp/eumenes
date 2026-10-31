import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { testConversationAgent } from "../../domains/dialogue/test/conversation-agent.fixture";
import { createContinuityService } from "../../domains/continuity";
import { openStore } from "../../infrastructure/sqlite";
import { createQueue } from "../../domains/queue";
import { createScheduler } from "../../domains/scheduler";
import { createConversationService } from "../../domains/conversation";
import { createDialogueService } from "../../domains/dialogue";
import { createVoiceDialogue } from "../../domains/voice-dialogue";
import type { LarmPort } from "../../domains/larm";
import { createTasks } from "../../domains/tasks";
import { createTaskSchema } from "../../domains/tasks/contracts";
import { createClient, ApiError } from "../../../client";
import { createApp } from "../app";
import { appModules } from "../app-modules";
import { migrations } from "../migrations";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});
const T0 = Date.parse("2026-10-09T00:00:00Z"),
	token = "fixture-token".repeat(3);
/** A task kind whose execution is unavailable: registration works, starting is an explicit 503. */
function setup() {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-tasks-http-")),
		path = join(dir, "db");
	const store = openStore(path, migrations);
	const queue = createQueue(store, { now: () => T0 });
	const scheduler = createScheduler(store, queue, { now: () => T0 });
	const tasks = createTasks(store, {
		now: () => T0,
		kinds: [
			{
				kind: "orchestration",
				version: 1,
				available: () => false,
				startInTransaction() {},
				stopInTransaction() {},
			},
		],
	});
	const conversation = createConversationService(store);
	const larm: LarmPort = {
		status: () => ({ state: "ready", capabilities: ["llm"] }),
		connect: async () => {},
		close: async () => {},
		answer: async () => "fixture answer",
		transcribe: async () => "",
		speak: async () => new Uint8Array(),
	};
	const dialogue = createDialogueService({
			conversationAgent: testConversationAgent,
			store,
			continuity: createContinuityService(store),
			queue,
			conversation,
			larm,
		}),
		voice = createVoiceDialogue(store, dialogue, larm);
	const app = createApp({
		token,
		origin: "http://127.0.0.1:5173",
		modules: appModules({
			queue,
			scheduler,
			conversation,
			dialogue,
			voice,
			larm,
			tasks,
		}),
	});
	cleanup.push(async () => {
		await scheduler.close();
		await queue.close(1000);
		await voice.close();
		await dialogue.close();
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	});
	const call = (
		path: string,
		body?: unknown,
		headers = {
			authorization: `Bearer ${token}`,
			"content-type": "application/json",
		},
	) =>
		app.request(path, {
			headers,
			...(body === undefined
				? {}
				: { method: "POST", body: JSON.stringify(body) }),
		});
	return { tasks, call, app, dir };
}
function input(startMode: "start" | "register_only" = "start") {
	return createTaskSchema.parse({
		requestId: crypto.randomUUID(),
		kind: "orchestration",
		version: 1,
		title: "fixture task",
		request: "implement a change",
		completionConditions: ["checks pass"],
		startMode,
		grant: {
			connectionRef: "fixture-connection",
			projectRef: "fixture-project",
			operations: ["read", "edit", "check"],
			expiresAt: new Date(T0 + 3_600_000).toISOString(),
		},
	});
}
test("task HTTP bodies are rejected while streaming past the bound, before the peer finishes sending", async () => {
	const h = setup();
	let chunks = 0,
		cancelled = false;
	const body = new ReadableStream<Uint8Array>(
		{
			pull(controller) {
				chunks++;
				if (chunks <= 5) controller.enqueue(new Uint8Array(17_000).fill(32));
				else controller.close();
			},
			cancel() {
				cancelled = true;
			},
		},
		{ highWaterMark: 0 },
	);
	const response = await h.app.request(
		new Request("http://localhost/api/tasks", {
			method: "POST",
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "application/json",
			},
			body,
		}),
	);
	expect(response.status).toBe(413);
	expect(chunks).toBe(4);
	expect(cancelled).toBe(true);
	expect(h.tasks.list().items).toHaveLength(0);
});
test("HTTP rejects spoofed origins and arbitrary state, authenticates tasks, and validates query limits", async () => {
	const h = setup(),
		data = input("register_only");
	expect(
		(
			await h.call("/api/tasks", data, {
				authorization: "",
				"content-type": "application/json",
			})
		).status,
	).toBe(401);
	expect(
		(
			await h.call("/api/tasks", {
				...data,
				origin: { source: "conversation", messageId: "forged" },
			})
		).status,
	).toBe(400);
	expect(
		(await h.call("/api/tasks", { ...data, state: "completed" })).status,
	).toBe(400);
	const response = await h.call("/api/tasks", data);
	expect(response.status).toBe(202);
	const r = (await response.json()) as { taskId: string };
	expect(response.headers.get("X-Request-Id")).toBeString();
	expect((await h.call(`/api/tasks/${r.taskId}`)).status).toBe(200);
	expect((await h.call("/api/tasks?limit=101")).status).toBe(400);
	expect((await h.call("/api/tasks?state=anything")).status).toBe(400);
	expect((await h.call("/api/tasks/missing")).status).toBe(404);
	expect(
		(await h.call(`/api/tasks/${r.taskId}/events?cursor=999`)).status,
	).toBe(400);
});
test("API client and CLI register, read and cancel through authenticated HTTP; unavailable execution stays explicit", async () => {
	const h = setup(),
		server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: h.app.fetch });
	cleanup.push(async () => {
		await server.stop(true);
	});
	const url = `http://127.0.0.1:${server.port}`,
		client = createClient(url, token);
	const data = input("register_only");
	const created = await client.createTask({
		...data,
		grant: {
			connectionRef: data.grant.connectionRef,
			projectRef: data.grant.projectRef,
			operations: data.grant.operations,
			expiresAt: data.grant.expiresAt,
		},
	});
	const detail = await client.workTask(created.taskId);
	expect(detail.task.state).toBe("registered");
	expect(detail.task.grant.maxRuntimeMs).toBe(7_200_000);
	expect(detail.task.grant.progressIntervalMs).toBe(300_000);
	try {
		await client.startTask(
			created.taskId,
			crypto.randomUUID(),
			created.revision,
		);
		throw new Error("expected error");
	} catch (error) {
		expect(error).toBeInstanceOf(ApiError);
		expect((error as ApiError).status).toBe(503);
	}
	const dataFile = join(h.dir, "task.json");
	writeFileSync(dataFile, JSON.stringify(input("register_only")), {
		mode: 0o600,
	});
	async function cli(args: string[]) {
		const child = Bun.spawn(
			[process.execPath, "cli/index.ts", "tasks", ...args, "--json"],
			{
				cwd: resolve(import.meta.dir, "../../.."),
				env: {
					PATH: process.env.PATH,
					EUMENES_URL: url,
					EUMENES_API_TOKEN: token,
				},
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const [code, out, error] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		return { code, out, error };
	}
	const result = await cli(["create", dataFile]);
	expect(result.code).toBe(0);
	const receipt = JSON.parse(result.out);
	for (const args of [
		["list"],
		["show", receipt.taskId],
		["events", receipt.taskId],
	])
		expect((await cli(args)).code).toBe(0);
	const failedStart = await cli([
		"start",
		receipt.taskId,
		String(receipt.revision),
	]);
	expect(failedStart.code).toBe(3);
	expect(failedStart.out).toBe("");
	expect(failedStart.error).toMatch(/Request ID: [0-9a-f-]{36}/);
	const startInput = input("start");
	const { requestId: _requestId, ...generatedInput } = startInput;
	writeFileSync(dataFile, JSON.stringify(generatedInput), { mode: 0o600 });
	const failedCreate = await cli(["create", dataFile]);
	expect(failedCreate.code).toBe(3);
	expect(failedCreate.out).toBe("");
	expect(failedCreate.error).toMatch(/Request ID: [0-9a-f-]{36}/);
	expect(
		(await cli(["stop", receipt.taskId, String(receipt.revision), "cancel"]))
			.code,
	).toBe(0);
	expect((await client.workTask(receipt.taskId)).task.state).toBe("cancelled");
	expect((await cli(["start", receipt.taskId, "-1"])).code).toBe(2);
});
