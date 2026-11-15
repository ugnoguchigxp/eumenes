import { expect, test } from "bun:test";
import { waitFor } from "../../../infrastructure/wait-for";
import { artifact, fixture, job, videoId } from "./video.fixture";

const until = (check: () => boolean, timeout = 3500) =>
	waitFor(check, { timeout, interval: 10 });

test("double click and lost acceptance keep the UUID and exact frozen POST across restart", async () => {
	const f = fixture();
	f.state.loseFirst = true;
	let host = f.open();
	try {
		const id = crypto.randomUUID();
		const input = { prompt: "A dog walks", title: "A dog", seed: 0 };
		await Promise.all([
			host.service.submit(id, input),
			host.service.submit(id, input),
		]);
		await until(() => host.service.snapshot().request?.state === "unconfirmed");
		expect(f.accepted.size).toBe(1);
		expect(f.requests.filter((r) => r.method === "POST")).toHaveLength(1);
		await expect(
			host.service.submit(id, { ...input, seed: 1 }),
		).rejects.toThrow("idempotency_conflict");
		await host.close();
		host = f.open();
		f.state.model = "changed-since-post";
		expect(host.service.snapshot().request?.id).toBe(id);
		expect(host.service.snapshot().request?.state).toBe("unconfirmed");
		expect(f.requests.filter((r) => r.method === "POST")).toHaveLength(1);
		await host.service.reconcile(id);
		await until(() => host.service.snapshot().request?.job?.jobId === videoId);
		const posts = f.requests.filter((r) => r.method === "POST");
		expect(posts).toHaveLength(2);
		expect(posts[0]?.bytes).toBe(posts[1]?.bytes);
		expect(posts[0]?.key).toBe(posts[1]?.key);
		expect(JSON.parse(String(posts[0]?.bytes))).toEqual({
			...input,
			model: "fixture-model",
		});
		expect(f.accepted.size).toBe(1);
	} finally {
		await host.close();
		f.dispose();
	}
});

test("poll recovers the same job after a lost response and never completes during stopping", async () => {
	const f = fixture();
	f.state.saved = false;
	f.state.disconnectPoll = true;
	const host = f.open();
	try {
		const id = crypto.randomUUID();
		await host.service.submit(id, { prompt: "brief scene" });
		await until(() => host.service.snapshot().request?.state === "tracking");
		await until(
			() =>
				host.service.snapshot().request?.errorCode ===
				"video_connection_failed",
		);
		expect(f.requests.filter((r) => r.method === "DELETE")).toHaveLength(0);
		expect(host.service.admission().state).toBe("active");
		await expect(
			host.service.submit(crypto.randomUUID(), { prompt: "another" }),
		).rejects.toThrow("on_demand_busy");
		const posts = f.requests.filter((r) => r.method === "POST");
		const reads = f.requests.filter(
			(r) => r.path === f.state.job.statusUrl && r.method === "GET",
		);
		expect(reads[0]!.at - posts[0]!.at).toBeGreaterThanOrEqual(1950);
		const stopped = await host.service.cancel(id, new AbortController().signal);
		expect(stopped.job).toMatchObject({
			jobId: videoId,
			phase: "stopping",
			status: "running",
		});
		expect(stopped.job?.result).toBeUndefined();
		expect(host.service.admission().state).toBe("active");
		expect(
			f.requests.filter((r) => r.method === "DELETE").map((r) => r.path),
		).toEqual([f.state.job.statusUrl]);
		f.state.job = job("cancelled");
		await until(
			() => host.service.snapshot().request?.job?.status === "cancelled",
		);
		expect(host.service.admission().state).toBe("idle");
		expect(f.requests.filter((r) => r.method === "POST")).toHaveLength(1);
	} finally {
		await host.close();
		f.dispose();
	}
}, 8000);

test("failed worker stop preserves isolation and external admission refusal never retries", async () => {
	const f = fixture();
	f.state.job = job("failed", "failed", {
		result: artifact,
		error: { code: "worker_stop_failed" },
	});
	const host = f.open();
	try {
		await host.service.submit(crypto.randomUUID(), { prompt: "brief scene" });
		await until(() => host.service.admission().state === "isolated");
		expect(host.service.snapshot().request?.job?.result).toBeUndefined();
		f.state.busy = true;
		await host.service.submit(crypto.randomUUID(), {
			prompt: "retry after isolation",
		});
		await until(() => host.service.snapshot().request?.state === "rejected");
		expect(host.service.snapshot().request?.errorCode).toBe("on_demand_busy");
		expect(host.service.admission().state).toBe("isolated");
		expect(f.requests.filter((r) => r.method === "POST")).toHaveLength(2);
	} finally {
		await host.close();
		f.dispose();
	}
});

test("published size and duration values are independent and enforced before freezing a new POST", async () => {
	const f = fixture();
	f.state.width = { enum: [480, 640] };
	f.state.duration = { enum: [5, 7.5] };
	const host = f.open();
	try {
		expect(
			await host.service.discover(AbortSignal.timeout(3000)),
		).toMatchObject({
			options: {
				sizes: [
					{ width: 480, height: 480 },
					{ width: 640, height: 480 },
				],
				durations: [5, 7.5],
			},
		});
		const first = crypto.randomUUID();
		await host.service.submit(first, {
			prompt: "A scene",
			width: 480,
			height: 480,
			durationSeconds: 10,
		});
		await until(
			() =>
				host.service.snapshot().request?.errorCode === "invalid_video_request",
		);
		expect(f.accepted.size).toBe(0);
		const id = crypto.randomUUID();
		f.state.loseFirst = true;
		await host.service.submit(id, {
			prompt: "A scene",
			width: 640,
			height: 480,
			durationSeconds: 7.5,
		});
		await until(() => host.service.snapshot().request?.state === "unconfirmed");
		f.state.width = { const: 480 };
		f.state.duration = { const: 5 };
		await host.service.reconcile(id);
		await until(() => host.service.snapshot().request?.state === "tracking");
		const posts = f.requests.filter((r) => r.method === "POST");
		expect(posts).toHaveLength(2);
		expect(posts[0]?.bytes).toBe(posts[1]?.bytes);
		expect(JSON.parse(String(posts[1]?.bytes))).toMatchObject({
			width: 640,
			height: 480,
			durationSeconds: 7.5,
		});
		expect(f.accepted.size).toBe(1);
	} finally {
		await host.close();
		f.dispose();
	}
});
