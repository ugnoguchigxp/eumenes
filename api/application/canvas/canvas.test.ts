import { expect, test } from "bun:test";
import { CanvasService } from "eumenes-canvas/src/core/service";
import { PromptMaker } from "eumenes-canvas/src/core/prompt-maker";
import { Store } from "eumenes-canvas/src/core/store";
import { PreviewTokens } from "eumenes-canvas/src/server/preview";
import { createApp } from "../app";
import { createQueue } from "../../domains/queue";
import { migrations } from "../../domains/queue";
import {
	createConversationService,
	migrations as conversationMigrations,
} from "../../domains/conversation";
import { createCanvasAdapter } from "./adapter";
import { openStore } from "../../infrastructure/sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	canvasPreviewOrigin,
	makerChannel,
	type CanvasRuntime,
} from "./runtime";
import { createCanvasJobs } from "./jobs";
import { registerCanvasRoutes } from "./routes";

test("Canvas preview is on the other loopback site and requires an explicit port", () => {
	expect(canvasPreviewOrigin("http://127.0.0.1:5173")).toBeNull();
	expect(canvasPreviewOrigin("http://127.0.0.1:5173", "8790")).toBe(
		"http://localhost:8790",
	);
	expect(canvasPreviewOrigin("http://localhost:5173", "8790")).toBe(
		"http://127.0.0.1:8790",
	);
	expect(() => canvasPreviewOrigin("http://example.com", "8790")).toThrow(
		"config_invalid",
	);
	expect(() => canvasPreviewOrigin("http://localhost:5173", "8790; *")).toThrow(
		"config_invalid",
	);
});

test("the authenticated Canvas workbench can produce, preview, save and restore with the native service", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-canvas-test-"));
	const db = openStore(join(dir, "test.db"), [
		...migrations,
		...conversationMigrations,
	]);
	const queue = createQueue(db);
	const tokens = new PreviewTokens();
	const host = "http://127.0.0.1:5173";
	const preview = "http://localhost:8790";
	const service = new CanvasService({
		store: new Store(null),
		contract: "canvas-artwork/1",
		model: {
			label: "fixture",
			async generate() {
				return {
					body: {
						title: "図形",
						entry:
							"canvasApp.start(api => ({ frame() { api.ctx.fillRect(0, 0, 8, 8); } }));",
					},
					changes: "",
					unconfirmed: [],
					reply: "",
				};
			},
		},
		observer: {
			suite: "fixture",
			async observe() {
				return {
					environment: "fixture",
					checks: [
						{ id: "boot", level: "loaded", pass: true },
						{ id: "responds", level: "operated", pass: true },
					],
					observations: [],
				};
			},
			async close() {},
		},
	});
	const runtime: CanvasRuntime = {
		hostOrigin: host,
		previewOrigin: preview,
		service,
		issue: tokens.issue.bind(tokens),
		ready: () => true,
		async start() {},
		close: () => service.close(),
	};
	const conversation = createConversationService(db);
	const jobs = createCanvasJobs(queue, runtime, db, conversation);
	const app = createApp({
		token: "test-canvas-auth",
		origin: host,
		modules: [
			{ mount: (router) => registerCanvasRoutes(router, runtime, jobs) },
		],
	});
	const request = (path: string, body?: unknown, origin = host) =>
		app.request(host + "/api/canvas" + path, {
			method: body === undefined ? "GET" : "POST",
			headers: {
				Authorization: "Bearer test-canvas-auth",
				Origin: origin,
				"Content-Type": "application/json",
				"x-canvas-session": "fixture-session",
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		});
	try {
		expect(
			(await app.request(host + "/api/canvas/workbench/index.html")).status,
		).toBe(401);
		const page = await request("/workbench/index.html");
		expect(page.status).toBe(200);
		expect(page.headers.get("X-Frame-Options")).toBe("SAMEORIGIN");
		expect(await page.text()).toContain("<title>Canvasアプリ</title>");
		expect(page.headers.get("Content-Security-Policy")).toContain(
			`frame-src ${preview}`,
		);
		expect(
			(await request("/runs", { message: "図形を作って" }, preview)).status,
		).toBe(403);
		const started = await request("/runs", { message: "図形を作って" });
		expect(started.status).toBe(201);
		const { id } = await started.json();
		await service.drain();
		const run = await (await request(`/runs/${id}`)).json();
		expect(run.state).toBe("presented");
		const candidateId = run.presentedCandidateId;
		const issued = await (await request("/previews", { candidateId })).json();
		expect(tokens.take(issued.token)).toContain("fillRect");
		expect(tokens.take(issued.token)).toBeNull();
		const save = { expectedRevision: 0, idempotencyKey: "canvas-save-1" };
		const path = `/candidates/${candidateId}/save`;
		const saved = await (await request(path, save)).json();
		expect(saved.revision).toBe(1);
		expect((await (await request(path, save)).json()).replay).toBe(true);
		const restored = await (
			await request(`/artworks/${saved.artworkId}/restore`, {
				revision: 1,
				expectedRevision: 1,
				idempotencyKey: "canvas-restore-1",
			})
		).json();
		expect(restored.revision).toBe(2);
		const adapter = createCanvasAdapter(runtime, jobs, conversation);
		const accepted = await db.write((tx) => {
			conversation.appendInTransaction(tx, {
				id: "canvas-source",
				conversationId: "canvas-fixture",
				role: "user",
				text: "図形を作って",
				createdAt: new Date().toISOString(),
				runId: null,
			});
			return adapter.invokeInTransaction(tx, {
				operationName: "canvas.produce",
				input: {},
				requestId: "fixture-job",
				issuedAt: new Date().toISOString(),
				origin: {
					kind: "conversation",
					owner: {
						rootRunId: "fixture-run",
						taskId: "fixture-task",
						cancelEpoch: 0,
					},
					runId: "fixture-run",
					conversationId: "canvas-fixture",
					messageId: "canvas-source",
				},
			});
		});
		const job = db.read((tx) => jobs.byRequest(tx, "fixture-job"))!;
		queue.start();
		for (
			let attempt = 0;
			attempt < 50 && jobs.job(job.id)?.state !== "completed";
			attempt++
		)
			await Bun.sleep(20);
		expect(jobs.job(job.id)?.state).toBe("completed");
		expect(
			db.read((tx) => adapter.readInTransaction(tx, "fixture-job"))?.receiptRef,
		).toEqual(accepted.receiptRef);
		const latest = await (
			await request("/jobs/latest?conversationId=canvas-fixture")
		).json();
		expect(latest.id).toBe(job.id);
		expect(service.getRun("local:owner", latest.runId).state).toBe("presented");
		expect(accepted.receipt).toEqual({ jobId: job.id, state: "accepted" });
		const notice = conversation.message(`canvas-notice:${job.id}`);
		expect(notice).toMatchObject({
			conversationId: "canvas-fixture",
			role: "assistant",
			text: "Canvasアプリの候補を用意しました。アーティファクトで操作できます。",
		});
	} finally {
		await queue.close(1000);
		await service.close();
		await db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the Canvas maker uses its shipped Skill and calls the host model port", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-canvas-model-"));
	const db = openStore(join(dir, "test.db"), migrations);
	try {
		const model = new PromptMaker(
			makerChannel(db, {
				captureUserControlInTransaction(_tx, input) {
					expect(input.route).toBe("subagent");
					return "fixture-request";
				},
				async executeControl(id, messages, _signal, contract) {
					expect(id).toBe("fixture-request");
					expect(contract?.instructions).toContain("Canvas 作品の制作");
					expect(JSON.stringify(messages)).toContain("利用者の原依頼");
					return {
						requestId: id,
						attemptId: "fixture-attempt",
						value: JSON.stringify({
							title: "図形",
							entry: "canvasApp.start(() => ({}));",
							changes: "",
							unconfirmed: [],
							reply: "",
							spec: { requirements: ["図形"], controls: [] },
						}),
					};
				},
			}),
		);
		const result = await model.generate(
			{
				request: "利用者の原依頼",
				conversation: [],
				base: null,
				baseDigest: null,
				contract: "canvas-artwork/1",
				datasets: [],
				attempt: 0,
				previous: null,
				previousDigest: null,
				observations: [],
			},
			new AbortController().signal,
		);
		expect(result.body.title).toBe("図形");
	} finally {
		await db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
