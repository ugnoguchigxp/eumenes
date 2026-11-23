import { expect, test } from "bun:test";
import { join } from "node:path";
import { CanvasService } from "eumenes-canvas/src/core/service";
import { Store } from "eumenes-canvas/src/core/store";
import { createQueue } from "../../domains/queue";
import { canvasFixture, canvasFixtureOutput } from "./canvas.fixture";
import { createCanvasJobs } from "./jobs";

test.each([false, true])(
	"結果確定前の撤回を拒否し、Canvas取消失敗=%sでも候補を利用できない",
	async (cancelFails) => {
		const f = canvasFixture({ persistent: true });
		try {
			const id = await f.source("withdrawal boundary");
			const job = await f.invoke(id);
			if (cancelFails)
				f.service.cancelRun = async () => {
					throw new Error("fixture cancellation write failure");
				};
			const originalRead = f.db.read.bind(f.db);
			let scheduled = false;
			let withdrawn: Promise<unknown> | undefined;
			f.db.read = ((read) => {
				const value = originalRead(read);
				if (
					!scheduled &&
					Object.values(f.canvasStore.runs).some(
						(run) => run.requestKey === job.id && run.state === "presented",
					)
				) {
					scheduled = true;
					withdrawn = f.conversation.retract({ messageId: id });
				}
				return value;
			}) as typeof f.db.read;
			f.queue.start();
			await f.until(() => f.jobs.job(job.id)?.state === "failed");
			await withdrawn;
			expect(scheduled).toBe(true);
			expect(f.jobs.job(job.id)).toMatchObject({
				state: "failed",
				errorCode: "canvas_source_changed",
				resultRef: null,
			});
			expect(f.conversation.message(`canvas-notice:${job.id}`)?.text).toBe(
				"Canvasアプリの制作を完了できませんでした。アーティファクトで状態を確認できます。",
			);
			const run = f.jobs.runOf(job.id)!;
			const candidateId = run.presentedCandidateId!;
			expect(run.candidateIds).toHaveLength(1);
			expect(() =>
				f.service.resolvePreview("local:owner", { candidateId }),
			).toThrow();
			await expect(
				f.service.save("local:owner", candidateId, {
					expectedRevision: 0,
					idempotencyKey: "rejected_candidate",
				}),
			).rejects.toThrow();
			const visible = await (await f.request(`/runs/${run.id}`)).json();
			expect(visible.candidates).toEqual([]);
			expect((await f.request("/previews", { candidateId })).status).toBe(409);
			expect(
				(
					await f.request(`/candidates/${candidateId}/save`, {
						expectedRevision: 0,
						idempotencyKey: "rejected_candidate",
					})
				).status,
			).toBe(409);
			if (cancelFails) {
				// Reopen the Canvas file with a fresh queue registry; no worker or HTTP server starts.
				await f.queue.close();
				await f.service.close();
				const resumed = new CanvasService({
					store: new Store(join(f.dir, "canvas")),
					contract: "fixture",
					model: {
						label: "fixture",
						async generate() {
							throw new Error("must not regenerate");
						},
					},
					observer: {
						suite: "fixture",
						async observe() {
							throw new Error("unused");
						},
						async close() {},
					},
				});
				const queue = createQueue(f.db);
				const runtime = {
					...f.runtime,
					service: resumed,
					setCandidateAccess: resumed.setCandidateAccess.bind(resumed),
				};
				createCanvasJobs(queue, runtime, f.db, f.conversation);
				try {
					expect(resumed.getRun("local:owner", run.id).authority).toEqual({
						kind: "external",
						ref: job.id,
					});
					expect(() =>
						resumed.resolvePreview("local:owner", { candidateId }),
					).toThrow();
					await expect(
						resumed.save("local:owner", candidateId, {
							expectedRevision: 0,
							idempotencyKey: "after_restart_save",
						}),
					).rejects.toThrow();
				} finally {
					await queue.close();
					await resumed.close();
				}
			}
		} finally {
			await f.close();
		}
	},
);

test("採用済みジョブの参照失効も再表示・保存で拒否し、保存済み作品は保持する", async () => {
	const f = canvasFixture();
	try {
		const id = await f.source("valid job");
		const job = await f.invoke(id);
		f.queue.start();
		await f.until(() => f.jobs.job(job.id)?.state === "completed");
		const run = f.jobs.runOf(job.id)!;
		const candidateId = run.presentedCandidateId!;
		const request = {
			expectedRevision: 0,
			idempotencyKey: "already_saved_candidate",
		};
		const saved = await f.service.save("local:owner", candidateId, request);
		await f.conversation.retract({ messageId: id });
		expect(
			(
				await (
					await f.request("/jobs/latest?conversationId=canvas-review")
				).json()
			).state,
		).toBe("failed");
		expect(() =>
			f.service.resolvePreview("local:owner", { candidateId }),
		).toThrow();
		expect(
			(await f.service.save("local:owner", candidateId, request)).replay,
		).toBe(true);
		expect(
			f.service.resolvePreview("local:owner", {
				artworkId: (saved.result as { artworkId: string }).artworkId,
			}).body,
		).toEqual(canvasFixtureOutput.body);
	} finally {
		await f.close();
	}
});

test("採用元のない旧候補と、対応ジョブのない外部候補を直接制作と見なさない", async () => {
	const f = canvasFixture();
	try {
		for (const external of [false, true]) {
			const run = await f.service.startRun(
				"local:owner",
				"origin-" + external,
				{
					message: "request",
					...(external
						? {
								authority: { kind: "external" as const, ref: "missing-job" },
								requestKey: "missing-job",
							}
						: {}),
				},
			);
			await f.service.drain();
			const candidateId = f.service.getRun(
				"local:owner",
				run.id,
			).presentedCandidateId!;
			if (!external)
				await f.canvasStore.write((commit) =>
					commit(["runs"], (s) => {
						delete s.runs[run.id]!.authority;
					}),
				);
			expect(() =>
				f.service.resolvePreview("local:owner", { candidateId }),
			).toThrow();
			await expect(
				f.service.save("local:owner", candidateId, {
					expectedRevision: 0,
					idempotencyKey: "unknown_origin_" + external,
				}),
			).rejects.toThrow();
		}
	} finally {
		await f.close();
	}
});
