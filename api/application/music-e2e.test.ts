import { expect, test } from "bun:test";
import { harness } from "./toolchain.fixture";
import { musicFixture, musicQuestion, musicTestPlan } from "./music.fixture";

test("completed vocal music answers and repairs without re-offering entry operations", async () => {
	const question =
		"休日の朝に聞く目覚めのテーマ。クラシック、落ち着いたピアノ、90秒、透明感のある女性ソロ、日本語の歌詞をテーマに合わせて作成。";
	const f = musicFixture("success", {
		question,
		plan: {
			...musicTestPlan,
			durationSeconds: 90,
			instrumental: false,
			lyrics: "[Verse]\n朝の光で目を覚ます",
			language: "ja",
		},
	});
	const answers: Parameters<typeof f.model.answer>[0][] = [];
	const model = {
		...f.model,
		answer: async (...args: Parameters<typeof f.model.answer>) => {
			const [messages, , options] = args;
			if (messages.some((m) => m.content.includes('"musicResult":'))) {
				expect(options?.tools).toBeUndefined();
				answers.push(messages);
				return answers.length === 1
					? 'create_music{question:<|"|>休日の朝の楽曲<|"|>}'
					: "楽曲が完成しました。どうぞお楽しみください。";
			}
			return f.model.answer(...args);
		},
	};
	const h = await harness({ model, musicGateway: f.gateway });
	try {
		const submitted = await (
			await h.request("/api/runs", {
				requestId: crypto.randomUUID(),
				conversationId: "main",
				text: question,
			})
		).json();
		const run = await h.dialogue.waitForTerminal(submitted.id, {
			timeoutMs: 5000,
		});
		expect(run?.status).toBe("completed");
		expect(h.music!.list("main")[0]!.state).toBe("completed");
		expect(f.requests.filter((r) => r.method === "POST")).toHaveLength(1);
		expect(answers).toHaveLength(2);
		for (const messages of answers) {
			expect(
				messages.some(
					(m) =>
						m.role === "system" &&
						m.content.includes("最も合うfunctionを一つ呼びます"),
				),
			).toBe(false);
			expect(
				messages.some((m) => m.role === "user" && m.content === question),
			).toBe(true);
			const result = JSON.parse(
				messages.find((m) => m.content.startsWith('{"musicResult":'))!.content,
			).musicResult;
			expect(result.state).toBe("completed");
			expect(result.durationSeconds).toBe(90);
		}
		expect(answers[1]![0]!.role).toBe("system");
		expect(answers[1]![0]!.content).toContain("自然な回答本文だけ");
		expect(h.dialogue.answerText(submitted.id)).toBe(
			"楽曲が完成しました。どうぞお楽しみください。",
		);
	} finally {
		await h.close();
	}
});
for (const mode of [
	"success",
	"failure",
	"invalid-plan",
	"correctable-plan",
] as const)
	test(`music pipeline ${mode}: conversation, worker, API, result, audio`, async () => {
		const f = musicFixture(mode);
		const h = await harness({ model: f.model, musicGateway: f.gateway });
		try {
			const r = await h.request("/api/runs", {
				requestId: crypto.randomUUID(),
				conversationId: "main",
				text: musicQuestion,
			});
			expect(r.status).toBe(202);
			const submitted = await r.json();
			const run = await h.dialogue.waitForTerminal(submitted.id, {
				timeoutMs: 5000,
			});
			expect(run?.status).toBe("completed");
			const records = await (
				await h.request("/api/music?conversationId=main")
			).json();
			expect(records).toHaveLength(1);
			const music = records[0];
			const success = mode === "success" || mode === "correctable-plan";
			expect(music.state).toBe(success ? "completed" : "failed");
			const posts = f.requests.filter((r) => r.method === "POST");
			expect(posts).toHaveLength(mode === "invalid-plan" ? 0 : 1);
			expect(f.stages).toEqual(["route", "plan", "answer"]);
			const response = await h.request(`/api/music/${music.id}/audio`);
			if (success) {
				expect(posts[0]!.body).toMatchObject({
					prompt: musicTestPlan.prompt,
					durationSeconds: 30,
					instrumental: true,
					outputFormat: "opus",
				});
				expect(music.mime).toBe("audio/ogg");
				expect(music.jobId).toBe("track");
				expect(response.status).toBe(200);
				expect(response.headers.get("content-type")).toBe("audio/ogg");
				expect(new Uint8Array(await response.arrayBuffer())).toEqual(f.audio);
				expect(h.dialogue.answerText(submitted.id)).toContain("Artifact");
			} else {
				expect(response.status).toBe(404);
				expect(music.errorCode).toBe(
					mode === "failure"
						? "generation_unknown"
						: "music_plan_invalid_contract",
				);
			}
		} finally {
			await h.close();
		}
	});
test("cancel music while the provider is running, send DELETE and never adopt audio", async () => {
	const f = musicFixture("cancel");
	const h = await harness({ model: f.model, musicGateway: f.gateway });
	try {
		const r = await (
			await h.request("/api/runs", {
				requestId: crypto.randomUUID(),
				conversationId: "main",
				text: musicQuestion,
			})
		).json();
		for (let i = 0; i < 500 && !h.music!.list("main")[0]?.jobId; i++)
			await Bun.sleep(5);
		expect(h.music!.list("main")[0]?.jobId).toBe("track");
		await h.dialogue.cancel(r.id);
		for (
			let i = 0;
			i < 100 && !f.requests.some((r) => r.method === "DELETE");
			i++
		)
			await Bun.sleep(5);
		expect(f.requests.filter((r) => r.method === "DELETE")).toHaveLength(1);
		expect(h.music!.list("main")[0]?.state).toBe("cancelled");
		expect(h.dialogue.get(r.id)?.status).toBe("cancelled");
		expect(f.stages).toEqual(["route", "plan"]);
	} finally {
		await h.close();
	}
});
test("vocal orchestral music forwards the worker's voice description, exact lyrics and language through the authenticated API", async () => {
	const lyrics = "[Verse]\n朝の光が窓を照らす\n新しい一日が始まる";
	const question =
		"オーケストラ、柔らかい女性ボーカル、歌声あり、30秒。歌詞：\n" + lyrics;
	const plan = {
		...musicTestPlan,
		prompt:
			"Orchestral pop with soft clear female vocals, expressive strings and piano",
		instrumental: false,
		lyrics,
		language: "ja",
	};
	const f = musicFixture("success", { plan, question });
	const h = await harness({ model: f.model, musicGateway: f.gateway });
	try {
		const submitted = await (
			await h.request("/api/runs", {
				requestId: crypto.randomUUID(),
				conversationId: "main",
				text: question,
			})
		).json();
		await h.dialogue.waitForTerminal(submitted.id, { timeoutMs: 5000 });
		const music = h.music!.list("main")[0]!;
		expect(music.state).toBe("completed");
		expect(music).toMatchObject({
			instrumental: false,
			lyrics,
			language: "ja",
		});
		const posts = f.requests.filter(
			(request) =>
				request.path === "/v1/music/generations" && request.method === "POST",
		);
		expect(posts).toHaveLength(1);
		expect(posts[0]!.body).toMatchObject({
			prompt: plan.prompt,
			instrumental: false,
			lyrics,
			language: "ja",
			durationSeconds: 30,
			outputFormat: "opus",
		});
		expect(Object.keys(posts[0]!.body as object)).not.toContain("gender");
		expect(Object.keys(posts[0]!.body as object)).not.toContain("voice");
		expect(
			f.requests.some((request) => request.path.includes("/images/")),
		).toBe(false);
	} finally {
		await h.close();
	}
});
