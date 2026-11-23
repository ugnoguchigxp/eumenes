import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
	CanvasService,
	type ServiceOptions,
} from "eumenes-canvas/src/core/service";
import { Store } from "eumenes-canvas/src/core/store";
import { PreviewTokens } from "eumenes-canvas/src/server/preview";
import {
	createConversationService,
	migrations as conversationMigrations,
} from "../../domains/conversation";
import {
	createQueue,
	migrations as queueMigrations,
} from "../../domains/queue";
import type { AdapterOrigin } from "../../domains/tool-runtime";
import { openStore } from "../../infrastructure/sqlite";
import { createApp } from "../app";
import { createCanvasAdapter } from "./adapter";
import { createCanvasJobs } from "./jobs";
import { registerCanvasRoutes } from "./routes";
import type { CanvasRuntime } from "./runtime";

export const canvasFixtureBody = {
	title: "操作する四角形",
	entry: `canvasApp.start(api => { let x = 80; return { frame() { api.ctx.fillStyle = "#fff"; api.ctx.fillRect(0,0,api.width,api.height); api.ctx.fillStyle = "#2463eb"; api.ctx.fillRect(x,80,40,40); }, input(e) { if (e.type === "keydown" && e.code === "ArrowRight") x += 24; } }; });`,
};
export const canvasFixtureOutput = {
	body: canvasFixtureBody,
	changes: "",
	unconfirmed: [] as string[],
	reply: "候補です。",
	spec: {
		requirements: ["右矢印で四角形が右へ動く"],
		controls: [
			{ kind: "key", input: "ArrowRight", action: "右へ移動", always: true },
		],
	},
};

export function canvasFixture(
	options: Partial<Pick<ServiceOptions, "model" | "observer" | "review">> & {
		persistent?: boolean;
	} = {},
) {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-canvas-regression-"));
	const db = openStore(join(dir, "fixture.db"), [
		...queueMigrations,
		...conversationMigrations,
	]);
	const queue = createQueue(db, { pollMs: 5 });
	const conversation = createConversationService(db);
	const canvasStore = new Store(
		options.persistent ? join(dir, "canvas") : null,
	);
	const inputs: unknown[] = [];
	const service = new CanvasService({
		store: canvasStore,
		contract: "canvas-artwork/1",
		model: options.model ?? {
			label: "fixture",
			async generate(input) {
				inputs.push(structuredClone(input));
				return structuredClone(canvasFixtureOutput);
			},
		},
		observer: options.observer ?? {
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
		review: options.review,
	});
	const tokens = new PreviewTokens();
	const runtime: CanvasRuntime = {
		hostOrigin: "http://127.0.0.1:5173",
		previewOrigin: "http://localhost:8790",
		service,
		issue: tokens.issue.bind(tokens),
		ready: () => true,
		setCandidateAccess: service.setCandidateAccess.bind(service),
		async start() {},
		close: () => service.close(),
	};
	const jobs = createCanvasJobs(queue, runtime, db, conversation);
	const adapter = createCanvasAdapter(runtime, jobs, conversation);
	const app = createApp({
		token: "canvas-fixture",
		origin: runtime.hostOrigin,
		modules: [
			{ mount: (router) => registerCanvasRoutes(router, runtime, jobs) },
		],
	});
	const source = (
		text: string,
		id: string = randomUUID(),
		conversationId = "canvas-review",
	) =>
		db.write((tx) => {
			conversation.appendInTransaction(tx, {
				id,
				conversationId,
				role: "user",
				text,
				createdAt: new Date().toISOString(),
				runId: null,
			});
			return id;
		});
	async function invoke(
		messageId: string,
		input: Record<string, unknown> = {},
		requestId: string = randomUUID(),
		origin?: AdapterOrigin,
	) {
		const accepted = await db.write((tx) =>
			adapter.invokeInTransaction(tx, {
				operationName: "canvas.produce.v2",
				input,
				requestId,
				issuedAt: new Date().toISOString(),
				origin: origin ?? {
					kind: "conversation",
					owner: {
						rootRunId: "fixture",
						taskId: "fixture-task",
						cancelEpoch: 0,
					},
					runId: "fixture",
					conversationId: "canvas-review",
					messageId,
				},
			}),
		);
		queue.wake();
		return jobs.job((accepted.receipt as { jobId: string }).jobId)!;
	}
	async function until(predicate: () => boolean) {
		for (let n = 0; n < 300; n++) {
			if (predicate()) return;
			await Bun.sleep(10);
		}
		throw new Error("canvas_fixture_wait_timeout");
	}
	const request = (path: string, body?: unknown) =>
		app.request(runtime.hostOrigin + "/api/canvas" + path, {
			method: body === undefined ? "GET" : "POST",
			headers: {
				Authorization: "Bearer canvas-fixture",
				Origin: runtime.hostOrigin,
				"content-type": "application/json",
				"x-canvas-session": "canvas-fixture-session",
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		});
	async function save(
		message: string,
		artworkId?: string,
		expectedRevision = 0,
	) {
		const run = await service.startRun("local:owner", "seed-" + message, {
			message,
			artworkId,
		});
		await service.drain();
		const candidate = service.getRun(
			"local:owner",
			run.id,
		).presentedCandidateId!;
		return (
			await service.save("local:owner", candidate, {
				expectedRevision,
				idempotencyKey: "fixture_" + randomUUID(),
			})
		).result as { artworkId: string; revision: number; digest: string };
	}
	return {
		dir,
		db,
		queue,
		conversation,
		service,
		canvasStore,
		runtime,
		jobs,
		adapter,
		app,
		tokens,
		inputs,
		source,
		invoke,
		request,
		until,
		save,
		async close() {
			await queue.close(1000);
			await service.close();
			await db.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}
