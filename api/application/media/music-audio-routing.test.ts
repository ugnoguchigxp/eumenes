import { expect, test } from "bun:test";
import { musicFixture, musicTestPlan } from "./music.fixture";
import {
	ask,
	assignmentAgenda,
	ended,
	notes,
	plannedBy,
	until,
} from "./assignment.fixture";

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
	test(`assignment to saved audio: ${JSON.stringify(use)}`, async () => {
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
		const a = await assignmentAgenda({
			harness: { model: plannedBy({ music: f }), musicGateway: f.gateway },
		});
		const h = a.h;
		try {
			await a.start();
			await ask(a, "music.create", "この条件で音声を生成してください");
			await until(a, () => ended(a));
			const saved = h.music!.list("ao")[0]!;
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
			await a.close();
		}
	});
for (const options of [
	{ jobStatuses: ["failed"] },
	{ jobStatuses: ["cancelled"] },
	{ postStatus: 400 },
])
	test(`failed or cancelled generation never exposes audio: ${JSON.stringify(options)}`, async () => {
		const f = musicFixture("success", options);
		const a = await assignmentAgenda({
			harness: { model: plannedBy({ music: f }), musicGateway: f.gateway },
		});
		const h = a.h;
		try {
			await a.start();
			await ask(a, "music.create", "音声を生成");
			await until(a, () => ended(a));
			const item = h.music!.list("ao")[0]!;
			expect(item.state).toBe(
				options.jobStatuses?.[0] === "cancelled" ? "cancelled" : "failed",
			);
			expect((await h.request(`/api/music/${item.id}/audio`)).status).toBe(404);
			expect(
				f.requests.filter(
					(r) => r.method === "POST" && r.path === "/v1/music/generations",
				),
			).toHaveLength(1);
			// Nothing was made: the agent has no note of it to report.
			expect(notes(a)).toHaveLength(0);
		} finally {
			await a.close();
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
		const a = await assignmentAgenda({
			harness: { model: plannedBy({ music: f }), musicGateway: f.gateway },
		});
		const h = a.h;
		try {
			await a.start();
			await ask(a, "music.create", "音声を生成");
			await until(a, () => ended(a));
			expect(h.music!.list("ao")[0]!.state).toBe("failed");
			expect(
				f.requests.some(
					(r) => r.method === "POST" && r.path === "/v1/music/generations",
				),
			).toBe(false);
		} finally {
			await a.close();
		}
	});
