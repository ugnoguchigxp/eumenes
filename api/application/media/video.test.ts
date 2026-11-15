import { harness } from "../toolchain/toolchain.fixture";
import { handOver } from "./conversation-turn.fixture";
import { expect, test } from "bun:test";
import { createApp } from "../app";
import { registerVideo } from "../../domains/video";
import { fixture, artifact, job } from "../../domains/video/test/video.fixture";
import { waitFor } from "../../infrastructure/wait-for";
import { registerVideoAdmission } from "./video-admission";
import { createVideoAdapter } from "./video-adapter";

test("auth, Range, metadata, distinct deletion and interactive admission use the registered routes", async () => {
	const f = fixture();
	const h = f.open();
	try {
		const app = createApp({
			token: "eumenes-fixture",
			origin: "http://127.0.0.1:1234",
			modules: [
				{
					mount(app) {
						registerVideoAdmission(app, h.service);
						registerVideo(app, h.service);
						app.post("/api/runs", (c) => c.json({ accepted: true }, 202));
						app.post("/api/compute/jobs", (c) =>
							c.json({ accepted: true }, 202),
						);
					},
				},
			],
		});
		function request(
			path: string,
			method = "GET",
			headers: Record<string, string> = {},
		) {
			return app.request(path, {
				method,
				headers: { Authorization: "Bearer eumenes-fixture", ...headers },
			});
		}
		expect((await app.request("/api/videos")).status).toBe(401);
		const service = await request("/api/videos/service");
		expect(service.status).toBe(200);
		expect(await service.json()).toMatchObject({
			options: { sizes: [{ width: 480, height: 480 }], durations: [5] },
		});
		const path = `/api/videos/${artifact.id}`;
		const listing = await request("/api/videos");
		expect(await listing.json()).toEqual({ videos: [artifact] });
		const metadata = await request(path + "/metadata");
		expect(await metadata.json()).toMatchObject({
			request: { prompt: "text", seed: 42 },
		});
		const range = await request(path + "/content", "GET", {
			Range: "bytes=0-3",
		});
		expect(range.status).toBe(206);
		expect(range.headers.get("Content-Range")).toBe("bytes 0-3/16");
		expect(new Uint8Array(await range.arrayBuffer())).toEqual(
			new Uint8Array([0, 0, 0, 16]),
		);
		const adapter = createVideoAdapter(h.service);
		const start = () =>
			h.store.write((db) =>
				adapter.invokeInTransaction(db, {
					operationName: "video.generate",
					input: { prompt: "A short landscape" },
					requestId: "command-fixture-first",
					issuedAt: new Date().toISOString(),
					origin: { kind: "ui", scope: "main", actionRequestId: "fixture" },
				}),
			);
		const result = await start();
		expect(result.receipt).toMatchObject({ action: "generate" });
		expect((await start()).replay).toBe(true);
		const blocked = await request("/api/runs", "POST");
		expect(blocked.status).toBe(409);
		expect(await blocked.json()).toEqual({ error: "on_demand_busy" });
		expect((await request("/api/compute/jobs", "POST")).status).toBe(409);
		expect((await request("/api/videos")).status).toBe(200);
		f.state.job = job("completed", "completed", { result: artifact });
		await waitFor(() => h.service.admission().state === "idle", {
			timeout: 3000,
			interval: 10,
		});
		expect((await request("/api/runs", "POST")).status).toBe(202);
		expect((await request(path, "DELETE")).status).toBe(204);
		expect(await (await request("/api/videos")).json()).toEqual({ videos: [] });
		expect(f.requests.every((r) => r.auth === "Bearer control-fixture")).toBe(
			true,
		);
		expect(
			f.requests.filter((r) => r.method === "DELETE").map((r) => r.path),
		).toEqual([`/v1/videos/${artifact.id}`]);
	} finally {
		await h.close();
		f.dispose();
	}
});

test("a conversation selects the registered video command and receives a submission receipt while the job is running", async () => {
	const f = fixture();
	f.state.job = job("running", "generating");
	const h = await harness({
		videoPort: f.remote,
		firstRound: (_tools, _question, messages) =>
			handOver("video.studio", "動画を依頼します。")(messages),
		command: () =>
			JSON.stringify({
				action: "invoke",
				tool: "video.generate",
				arguments: { prompt: "Birds over water", title: "水辺の鳥" },
			}),
	});
	try {
		const run = await h.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: "水辺の鳥の動画を作って",
		});
		const result = await h.dialogue.waitForTerminal(run.id, {
			timeoutMs: 8000,
		});
		expect(result?.status).toBe("completed");
		expect(h.commandContexts[0]).toContain("video.generate");
		await waitFor(() => f.accepted.size === 1);
		expect(f.requests.filter((r) => r.method === "POST")).toHaveLength(1);
		const registered = await h.request(
			"/api/toolchain-artifacts/artifact%3Avideo.workspace%402",
		);
		expect(registered.status).toBe(200);
		const { artifacts: entries } = await (
			await h.request("/api/toolchain-artifacts")
		).json();
		expect(
			entries.filter(
				(item: { artifactId: string }) => item.artifactId === "video.workspace",
			),
		).toEqual([
			expect.objectContaining({
				artifactRevisionId: "artifact:video.workspace@2",
			}),
		]);
		const status = await h.request("/api/videos/workspace");
		expect(await status.json()).toMatchObject({
			request: {
				state: "tracking",
				job: { jobId: f.state.job.jobId, status: "running" },
			},
			admission: { state: "active" },
		});
		expect(h.reported()).toContain("動画生成の送信を開始しました");
	} finally {
		await h.close();
		f.dispose();
	}
}, 15000);
