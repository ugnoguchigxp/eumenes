import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
	CanvasService,
	ServiceError,
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
import {
	canvasOwner,
	type CanvasRuntime,
	type CanvasRuntimeOptions,
} from "./runtime";

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

type FixtureServiceOptions = Partial<
	Pick<ServiceOptions, "model" | "observer" | "review">
>;

export function canvasFixtureInstance(
	dataDir: string | null,
	options: FixtureServiceOptions = {},
) {
	const canvasStore = new Store(dataDir);
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
	let closing: Promise<void> | undefined;
	return {
		service,
		canvasStore,
		inputs,
		tokens,
		issue: tokens.issue.bind(tokens),
		isServiceError: (error: unknown): error is ServiceError =>
			error instanceof ServiceError,
		close: () => (closing ??= service.close()),
		async save(message: string, artworkId?: string, expectedRevision = 0) {
			const run = await service.startRun(canvasOwner, "seed-" + message, {
				message,
				artworkId,
			});
			await service.drain();
			const candidate = service.getRun(
				canvasOwner,
				run.id,
			).presentedCandidateId!;
			return (
				await service.save(canvasOwner, candidate, {
					expectedRevision,
					idempotencyKey: "fixture_" + randomUUID(),
				})
			).result as { artworkId: string; revision: number; digest: string };
		},
	};
}

export function canvasFixture(
	options: FixtureServiceOptions & {
		persistent?: boolean;
		runtime?: (
			config: CanvasRuntimeOptions,
			instance: ReturnType<typeof canvasFixtureInstance>,
		) => CanvasRuntime;
	} = {},
) {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-canvas-regression-"));
	const db = openStore(join(dir, "fixture.db"), [
		...queueMigrations,
		...conversationMigrations,
	]);
	const queue = createQueue(db, { pollMs: 5 });
	const conversation = createConversationService(db);
	const config = {
		hostOrigin: "http://127.0.0.1:5173",
		previewOrigin: "http://localhost:8790",
		dataDir: join(dir, "canvas"),
		store: db,
		inference: {},
	};
	const instance = canvasFixtureInstance(
		options.persistent ? config.dataDir : null,
		options,
	);
	const runtime: CanvasRuntime = options.runtime?.(config, instance) ?? {
		...config,
		...instance,
		ready: () => true,
		setCandidateAccess: instance.service.setCandidateAccess.bind(
			instance.service,
		),
		async start() {},
	};
	const jobs = createCanvasJobs(queue, runtime, db, conversation);
	const adapter = createCanvasAdapter(runtime, jobs, conversation);
	const app = createApp({
		token: "canvas-fixture",
		origin: runtime.hostOrigin,
		modules: [
			{ mount: (router) => registerCanvasRoutes(router, runtime, jobs) },
			{
				mount: (router) => {
					router.get("/api/fixture-ready", (c) => c.json({ ok: true }));
				},
			},
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
	return {
		...instance,
		dir,
		db,
		queue,
		conversation,
		runtime,
		jobs,
		adapter,
		app,
		source,
		invoke,
		request,
		until,
		async close() {
			await queue.close(1000);
			await runtime.close();
			if (options.runtime) await instance.close();
			await db.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}
