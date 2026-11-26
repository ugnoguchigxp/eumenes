import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createQueue } from "../../domains/queue";
import { waitFor } from "../../infrastructure/wait-for";
import {
	canvasFixture,
	canvasFixtureBody,
	canvasFixtureInstance,
} from "./canvas.fixture";
import { createCanvasJobs } from "./jobs";
import {
	canvasOwner,
	createCanvasRuntime,
	type CanvasRuntimeOptions,
} from "./runtime";
import { launchCanvas } from "./runtime-server";

test("認証とOriginを先に確認し、同時の初回利用は一度だけ初期化する", async () => {
	const gate = Promise.withResolvers<void>();
	let opens = 0;
	const f = canvasFixture({
		runtime: (config, instance) =>
			createCanvasRuntime(config, async (_config, access) => {
				opens++;
				await gate.promise;
				instance.service.setCandidateAccess(access);
				return instance;
			}),
	});
	try {
		const url = f.runtime.hostOrigin + "/api/canvas";
		expect((await f.app.request(url + "/workbench/index.html")).status).toBe(
			401,
		);
		expect(
			(
				await f.app.request(url + "/runs", {
					method: "POST",
					headers: { Authorization: "Bearer canvas-fixture" },
				})
			).status,
		).toBe(403);
		const cancel = new AbortController();
		cancel.abort(new Error("cancelled"));
		await expect(f.runtime.start(cancel.signal)).rejects.toThrow("cancelled");
		expect(opens).toBe(0);

		const caller = new AbortController();
		const cancelled = f.runtime.start(caller.signal);
		const page = f.request("/workbench/index.html");
		const search = f.adapter.instant!.run(
			"canvas.find",
			{},
			new AbortController().signal,
			{ conversationId: "canvas-review" },
		);
		await waitFor(() => opens === 1);
		caller.abort(new Error("cancelled"));
		await expect(cancelled).rejects.toThrow("cancelled");
		expect(f.runtime.ready()).toBe(false);
		gate.resolve();
		expect((await page).status).toBe(200);
		expect(await search).toMatchObject({ ok: true });
		expect(opens).toBe(1);
	} finally {
		gate.resolve();
		await f.close();
	}
});

test("待ち受けの途中で失敗した資源を閉じ、通常APIを保ったまま次のCanvas要求で再試行する", async () => {
	const listeners: Array<{
		fetch(request: Request): Response | Promise<Response>;
		closed: number;
	}> = [];
	let fail = true;
	const f = canvasFixture({
		runtime: (config) =>
			createCanvasRuntime(config, (options, access) =>
				launchCanvas(options, access, (listener) => {
					if (fail && listener.hostname === "::1") {
						fail = false;
						throw Object.assign(new Error("port conflict"), {
							code: "EADDRINUSE",
						});
					}
					const bound = { fetch: listener.fetch, closed: 0 };
					listeners.push(bound);
					return {
						port: listener.port || 9000 + listeners.length,
						async stop(active) {
							expect(active).toBe(true);
							bound.closed++;
						},
					};
				}),
			),
	});
	try {
		const response = await f.request("/workbench/index.html");
		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({
			error: "Canvasアプリが起動していません",
		});
		expect(listeners.map((listener) => listener.closed)).toEqual([1]);
		expect(existsSync(join(f.dir, "canvas"))).toBe(false);
		expect(
			(
				await f.app.request(f.runtime.hostOrigin + "/api/fixture-ready", {
					headers: { Authorization: "Bearer canvas-fixture" },
				})
			).status,
		).toBe(200);
		expect((await f.request("/workbench/index.html")).status).toBe(200);
		expect(listeners.map((listener) => listener.closed)).toEqual([
			1, 0, 0, 0, 0,
		]);
		const preview = listeners[1]!;
		const token = f.runtime.issue(canvasFixtureBody);
		expect(
			(await preview.fetch(new Request(f.runtime.hostOrigin))).status,
		).toBe(421);
		const worker = f.runtime.previewOrigin + "/w/" + token;
		expect(
			(
				await preview.fetch(
					new Request(worker, { headers: { "sec-fetch-dest": "document" } }),
				)
			).status,
		).toBe(403);
		expect(
			(
				await preview.fetch(
					new Request(worker, { headers: { "sec-fetch-dest": "worker" } }),
				)
			).status,
		).toBe(200);
		expect((await preview.fetch(new Request(worker))).status).toBe(410);
	} finally {
		await f.close();
	}
	expect(listeners.map((listener) => listener.closed)).toEqual([1, 1, 1, 1, 1]);
});

test("初期化中の終了は呼出しを解放し、遅れて得た資源も一度だけ閉じる", async () => {
	const gate = Promise.withResolvers<void>();
	let opens = 0;
	let closes = 0;
	const f = canvasFixture({
		runtime: (config, instance) =>
			createCanvasRuntime(config, async () => {
				opens++;
				await gate.promise;
				return {
					...instance,
					async close() {
						closes++;
						await instance.close();
					},
				};
			}),
	});
	try {
		const starting = f.runtime.start();
		await waitFor(() => opens === 1);
		const closing = f.runtime.close();
		await expect(starting).rejects.toThrow("canvas_unavailable");
		await expect(f.runtime.start()).rejects.toThrow("canvas_unavailable");
		gate.resolve();
		await closing;
		await f.runtime.close();
		expect([opens, closes]).toEqual([1, 1]);
		expect(f.runtime.ready()).toBe(false);
	} finally {
		gate.resolve();
		await f.close();
	}
});

test("検索の初期化中に権限が失効すると、制作が参照する作品一覧を更新しない", async () => {
	const gate = Promise.withResolvers<void>();
	const opening = Promise.withResolvers<void>();
	let authorized = true;
	const f = canvasFixture({
		runtime: (config, instance) =>
			createCanvasRuntime(config, async () => {
				opening.resolve();
				await gate.promise;
				return instance;
			}),
	});
	try {
		const saved = await f.save("保存済みの作品");
		const context = {
			conversationId: "canvas-review",
			assertCurrent() {
				if (!authorized) throw new Error("permission_revoked");
			},
		};
		const search = f.adapter.instant!.run(
			"canvas.find",
			{ query: "対象のない検索" },
			new AbortController().signal,
			context,
		);
		await opening.promise;
		authorized = false;
		gate.resolve();
		await expect(search).rejects.toThrow("permission_revoked");
		expect(
			f.runtime.service.catalog.snapshot(canvasOwner, context.conversationId)
				.artworks,
		).toMatchObject([{ artworkId: saved.artworkId }]);
	} finally {
		gate.resolve();
		await f.close();
	}
});

test("キューの初期化待ちに原文を撤回するとMakerを呼ばない", async () => {
	const gate = Promise.withResolvers<void>();
	const opening = Promise.withResolvers<void>();
	const f = canvasFixture({
		runtime: (config, instance) =>
			createCanvasRuntime(config, async (_config, access) => {
				opening.resolve();
				await gate.promise;
				instance.service.setCandidateAccess(access);
				return instance;
			}),
	});
	try {
		const messageId = await f.source("操作する四角形を作って");
		const job = await f.invoke(messageId);
		await f.queue.tick();
		await opening.promise;
		await f.conversation.retract({ messageId });
		gate.resolve();
		await f.until(() => f.jobs.job(job.id)?.state === "failed");
		expect(f.jobs.job(job.id)?.errorCode).toBe("canvas_source_changed");
		expect(f.inputs).toEqual([]);
		expect(f.jobs.runOf(job.id)).toBeNull();
	} finally {
		gate.resolve();
		await f.close();
	}
});

test("復旧時に前回の実行を中断し、既存の待機ジョブが実行される時点で初期化する", async () => {
	const gate = Promise.withResolvers<void>();
	let config: CanvasRuntimeOptions;
	const f = canvasFixture({
		persistent: true,
		runtime: (options, instance) => {
			config = options;
			return createCanvasRuntime(options, async () => {
				await gate.promise;
				return instance;
			});
		},
	});
	const nextQueue = createQueue(f.db);
	let opens = 0;
	const next = createCanvasRuntime(config!, async (options, access) => {
		opens++;
		const instance = canvasFixtureInstance(options.dataDir);
		instance.service.setCandidateAccess(access);
		return instance;
	});
	const nextJobs = createCanvasJobs(nextQueue, next, f.db, f.conversation);
	try {
		const running = await f.invoke(await f.source("最初の依頼"));
		await f.queue.tick();
		expect(f.jobs.job(running.id)?.state).toBe("running");
		const oldRun = await f.service.startRun(canvasOwner, "earlier-host", {
			message: "最初の依頼",
			requestKey: running.id,
			authority: { kind: "external", ref: running.id },
		});
		await f.service.drain();
		expect(f.service.getRun(canvasOwner, oldRun.id).state).toBe("presented");
		const queued = await f.invoke(await f.source("次の依頼"));

		expect(await nextQueue.recover()).toBe(1);
		expect(nextJobs.job(running.id)).toMatchObject({
			state: "interrupted",
			errorCode: "backend_restarted",
			resultRef: null,
		});
		expect(nextJobs.job(queued.id)?.state).toBe("queued");
		expect(opens).toBe(0);
		gate.resolve();
		await f.queue.close(1000);
		await f.runtime.close();

		await nextQueue.tick();
		await f.until(() => nextJobs.job(queued.id)?.state === "completed");
		expect(opens).toBe(1);
		expect(nextJobs.visibleRun(oldRun.id)).toMatchObject({
			state: "failed",
			presentedCandidateId: null,
			candidates: [],
		});
		expect(nextJobs.visibleRun(nextJobs.runOf(queued.id)!.id).state).toBe(
			"presented",
		);
	} finally {
		gate.resolve();
		await nextQueue.close(1000);
		await next.close();
		await f.close();
	}
});
