import { expect, test } from "bun:test";
import { harness } from "../toolchain/toolchain.fixture";
import { musicFixture, musicTestPlan } from "./music.fixture";

const uses = [
	{ task: "music", instrumental: true, durationSeconds: 120 },
	{
		task: "music",
		instrumental: false,
		lyrics: "[Verse]\n朝の光",
		durationSeconds: 600,
	},
	{ task: "sound-effect", durationSeconds: 1.5 },
];
for (const use of uses)
	test(`conversation to saved audio: ${JSON.stringify(use)}`, async () => {
		const plan = {
			title: musicTestPlan.title,
			description: musicTestPlan.description,
			prompt: musicTestPlan.prompt,
			...use,
		};
		const f = musicFixture("success", {
			plan,
			jobStatuses: ["queued", "loading", "generating", "encoding", "completed"],
		});
		const h = await harness({ model: f.model, musicGateway: f.gateway });
		try {
			const response = await h.request("/api/runs", {
				requestId: crypto.randomUUID(),
				conversationId: "main",
				text: "この条件で音声を生成してください",
			});
			const run = await response.json();
			expect(
				(await h.dialogue.waitForTerminal(run.id, { timeoutMs: 5000 }))?.status,
			).toBe("completed");
			const saved = h.music!.list("main")[0]!;
			expect(saved).toMatchObject({
				state: "completed",
				task: use.task,
				durationSeconds: use.durationSeconds,
				actualModel: "fixture-runtime-model",
				runtime: "fixture-runtime",
			});
			const posts = f.requests.filter(
				(r) => r.method === "POST" && r.path === "/v1/music/generations",
			);
			expect(posts).toHaveLength(1);
			expect(posts[0]!.body).toMatchObject({ model: "auto", ...use });
			if (use.task === "sound-effect")
				expect(Object.hasOwn(posts[0]!.body as object, "lyrics")).toBe(false);
			expect(
				new Uint8Array(
					await (await h.request(`/api/music/${saved.id}/audio`)).arrayBuffer(),
				),
			).toEqual(f.audio);
			expect(
				await (await h.request("/api/music/tracks/track/generation")).json(),
			).toMatchObject({ task: use.task, runtime: "fixture-runtime" });
			expect((await h.request("/api/music/providers")).status).toBe(200);
		} finally {
			await h.close();
		}
	});
for (const options of [
	{ jobStatuses: ["failed"] },
	{ jobStatuses: ["cancelled"] },
	{ postStatus: 400 },
])
	test(`failed or cancelled generation never exposes audio: ${JSON.stringify(options)}`, async () => {
		const f = musicFixture("success", options);
		const h = await harness({ model: f.model, musicGateway: f.gateway });
		try {
			const submitted = await (
				await h.request("/api/runs", {
					requestId: crypto.randomUUID(),
					conversationId: "main",
					text: "音声を生成",
				})
			).json();
			await h.dialogue.waitForTerminal(submitted.id, { timeoutMs: 5000 });
			const item = h.music!.list("main")[0]!;
			expect(item.state).toBe(
				options.jobStatuses?.[0] === "cancelled" ? "cancelled" : "failed",
			);
			expect((await h.request(`/api/music/${item.id}/audio`)).status).toBe(404);
			expect(
				f.requests.filter(
					(r) => r.method === "POST" && r.path === "/v1/music/generations",
				),
			).toHaveLength(1);
			expect(h.dialogue.answerText(submitted.id)).not.toBe(
				"楽曲ができました。",
			);
		} finally {
			await h.close();
		}
	});
for (const invalid of [
	{ task: "sound-effect", lyrics: "wrong" },
	{ task: "music", instrumental: true, lyrics: "wrong" },
	{ task: "music", instrumental: true, durationSeconds: 121 },
])
	test(`invalid input never submits a generation: ${JSON.stringify(invalid)}`, async () => {
		const f = musicFixture("success", {
			plan: { ...musicTestPlan, ...invalid },
		});
		const h = await harness({ model: f.model, musicGateway: f.gateway });
		try {
			const run = await (
				await h.request("/api/runs", {
					requestId: crypto.randomUUID(),
					conversationId: "main",
					text: "音声を生成",
				})
			).json();
			await h.dialogue.waitForTerminal(run.id, { timeoutMs: 5000 });
			expect(h.music!.list("main")[0]!.state).toBe("failed");
			expect(
				f.requests.some(
					(r) => r.method === "POST" && r.path === "/v1/music/generations",
				),
			).toBe(false);
		} finally {
			await h.close();
		}
	});
