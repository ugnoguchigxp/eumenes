import { expect, test } from "bun:test";
import { canvasFixture, canvasFixtureOutput } from "./canvas.fixture";

test("画面からの編集も版参照を必須にし、同じ受付を重複実行しない", async () => {
	const f = canvasFixture();
	try {
		const saved = await f.save("initial");
		expect(
			(
				await f.request("/runs", {
					message: "変更",
					artworkId: saved.artworkId,
				})
			).status,
		).toBe(400);
		const input = {
			message: "変更",
			artworkId: saved.artworkId,
			expectedBase: { revision: 1, digest: saved.digest },
			requestKey: "native-request-1",
		};
		const first = await (await f.request("/runs", input)).json();
		await f.service.drain();
		const second = await (await f.request("/runs", input)).json();
		expect(second.id).toBe(first.id);
		await f.save("updated", saved.artworkId, 1);
		expect(
			(await f.request("/runs", { ...input, requestKey: "native-request-2" }))
				.status,
		).toBe(409);
	} finally {
		await f.close();
	}
});

test("期限前に実行できなかった受付と、取消した受付を生成成功として返さない", async () => {
	const f = canvasFixture();
	try {
		const id = await f.source("request");
		const expired = await f.db.write((db) =>
			f.jobs.submit(
				db,
				{
					conversationId: "canvas-review",
					message: "request",
					sourceRefs: [{ messageId: id, digest: "unused" }],
				},
				"expired-request",
				Date.now() - 1,
			),
		);
		const cancelled = await f.invoke(id);
		await f.jobs.cancel(cancelled.id);
		f.queue.start();
		await f.until(() => f.jobs.job(expired.job.id)?.state === "expired");
		expect(f.jobs.job(cancelled.id)?.state).toBe("cancelled");
		expect(f.inputs).toHaveLength(0);
		expect(f.jobs.runOf(expired.job.id)).toBeNull();
		expect(f.jobs.runOf(cancelled.id)).toBeNull();
	} finally {
		await f.close();
	}
});

test("失敗したrunも受付キーからAPIで追跡でき、受付票は変化しない", async () => {
	const f = canvasFixture({
		persistent: true,
		model: {
			label: "fixture",
			async generate() {
				throw new Error("fixture_failure");
			},
		},
	});
	try {
		const id = await f.source("request");
		const job = await f.invoke(id);
		const receipt = f.db.read((tx) =>
			f.adapter.readInTransaction(tx, job.dedupeKey),
		);
		f.queue.start();
		await f.until(() => f.jobs.job(job.id)?.state === "failed");
		const latest = await (
			await f.request("/jobs/latest?conversationId=canvas-review")
		).json();
		expect(latest).toMatchObject({
			id: job.id,
			state: "failed",
			errorCode: "canvas_generation_failed",
		});
		expect(latest.runId).toBeString();
		expect(
			(await (await f.request(`/runs/${latest.runId}`)).json()).state,
		).toBe("failed");
		expect(
			f.db.read((tx) => f.adapter.readInTransaction(tx, job.dedupeKey))
				?.receiptRef,
		).toEqual(receipt?.receiptRef);
	} finally {
		await f.close();
	}
});

test("提示した版から受付後に別版を保存すると、Makerを呼ばず競合で終了する", async () => {
	const f = canvasFixture();
	try {
		const first = await f.save("initial_revision");
		const page = f.service.catalog.page("local:owner", "canvas-review");
		const id = await f.source("色を変更");
		const job = await f.invoke(id, { targetRef: page.artworks[0]!.targetRef });
		await f.save("second_revision", first.artworkId, 1);
		const calls = f.inputs.length;
		f.queue.start();
		await f.until(() => f.jobs.job(job.id)?.state === "failed");
		expect(f.jobs.job(job.id)?.errorCode).toBe("canvas_revision_conflict");
		expect(f.inputs).toHaveLength(calls);
	} finally {
		await f.close();
	}
});

test("同じ受付を再送してもジョブ・run・完了通知は増えない", async () => {
	const f = canvasFixture();
	try {
		const id = await f.source("request");
		const first = await f.invoke(id, {}, "same-request");
		const second = await f.invoke(id, {}, "same-request");
		expect(second.id).toBe(first.id);
		f.queue.start();
		await f.until(() => f.jobs.job(first.id)?.state === "completed");
		expect((await f.invoke(id, {}, "same-request")).id).toBe(first.id);
		expect(f.inputs).toHaveLength(1);
		expect(f.conversation.message(`canvas-notice:${first.id}`)).toBeDefined();
		await expect(
			f.invoke(id, { request: "different" }, "same-request"),
		).rejects.toThrow("request_conflict");
	} finally {
		await f.close();
	}
});

test("生成中に原文を撤回しても、遅い候補を採用しない", async () => {
	const release = Promise.withResolvers<void>();
	const entered = Promise.withResolvers<void>();
	const f = canvasFixture({
		model: {
			label: "fixture",
			async generate() {
				entered.resolve();
				await release.promise;
				return structuredClone(canvasFixtureOutput);
			},
		},
	});
	try {
		const id = await f.source("request");
		const job = await f.invoke(id);
		f.queue.start();
		await entered.promise;
		await f.conversation.retract({ messageId: id });
		release.resolve();
		await f.until(() => f.jobs.job(job.id)?.state === "failed");
		expect(f.jobs.runOf(job.id)).toMatchObject({
			state: "cancelled",
			candidateIds: [],
		});
	} finally {
		release.resolve();
		await f.close();
	}
});

test("古い作品の検索結果は同じ会話のsnapshotへ渡り、他会話は参照できない", async () => {
	const f = canvasFixture();
	try {
		for (let n = 0; n < 26; n++) await f.save("work_" + n);
		const response = await f.request(
			"/artwork-search?conversationId=canvas-review",
		);
		expect(response.status).toBe(200);
		const first = await response.json();
		expect(first.artworks).toHaveLength(25);
		const second = await (
			await f.request(
				"/artwork-search?conversationId=canvas-review&cursor=" +
					encodeURIComponent(first.nextCursor),
			)
		).json();
		expect(second.artworks).toHaveLength(1);
		const snapshot = f.db.read((tx) =>
			f.adapter.snapshotInTransaction(tx, { conversationId: "canvas-review" }),
		) as typeof second;
		expect(snapshot.artworks[0].targetRef).toBe(second.artworks[0].targetRef);
		const id = await f.source("変更");
		const invalid = f.service.catalog.page(
			"local:owner",
			"different-conversation",
		).artworks[0]!;
		await expect(
			f.invoke(id, { targetRef: invalid.targetRef }),
		).rejects.toThrow("canvas_target_expired");
	} finally {
		await f.close();
	}
});
