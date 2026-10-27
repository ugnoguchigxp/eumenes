import { expect, test } from "bun:test";
import { harness } from "../toolchain/toolchain.fixture";
import { musicFixture, musicQuestion, musicTestPlan } from "./music.fixture";
import { imageFixture, imageQuestion } from "./image.fixture";
import { waitFor } from "../../infrastructure/wait-for";
import {
	afterUtterance,
	isUtteranceRound,
	toolResults,
} from "../toolchain/conversation-script.fixture";

test("a premature creation claim accompanying the selected operation is withheld until music completes", async () => {
	const f = musicFixture("success");
	const claim = "新しい曲を1曲作りました。再生：https://127.0.0.1:8000/play/";
	let reviewed = 0;
	let release!: () => void;
	const paused = new Promise<void>((resolve) => (release = resolve));
	const visible: string[] = [];
	const model = {
		...f.model,
		answer: async (...args: Parameters<typeof f.model.answer>) => {
			const [messages, signal, options] = args;
			// The generation that hands the work over: its speech beside the delegate call is a preamble (withdrawn).
			const handsOver =
				isUtteranceRound(options) &&
				toolResults(afterUtterance(messages), "find_toolchain").length > 0;
			if (handsOver) {
				await paused;
				reviewed++;
				await f.model.answer(messages, signal, options);
				return claim;
			}
			return f.model.answer(messages, signal, options);
		},
	};
	const h = await harness({ model, musicGateway: f.gateway });
	let unsubscribe = () => {};
	try {
		const submitted = await (
			await h.request("/api/runs", {
				requestId: crypto.randomUUID(),
				conversationId: "main",
				text: musicQuestion,
			})
		).json();
		unsubscribe = h.dialogue.subscribeProgress(submitted.id, (progress) =>
			visible.push(progress.text),
		);
		release();
		const run = await h.dialogue.waitForTerminal(submitted.id, {
			timeoutMs: 5000,
		});
		expect(run?.status).toBe("completed");
		expect(reviewed).toBe(1);
		expect(h.music!.list("main")[0]?.state).toBe("completed");
		expect(f.requests.filter((r) => r.method === "POST")).toHaveLength(1);
		expect(h.dialogue.answerText(submitted.id) ?? "").not.toContain(claim);
		expect(visible.every((text) => !text.includes(claim))).toBe(true);
	} finally {
		release();
		unsubscribe();
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
			expect(f.stages).toEqual(["route", "plan"]);
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
				// The finished work is reported by the agency, not by a conversation reply of this run.
				expect(h.dialogue.answerText(submitted.id)).toBeNull();
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
		await waitFor(() => !!h.music!.list("main")[0]?.jobId);
		expect(h.music!.list("main")[0]?.jobId).toBe("track");
		await h.dialogue.cancel(r.id);
		await waitFor(() => f.requests.some((r) => r.method === "DELETE"));
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
	const f = musicFixture("success", { plan });
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
test("artwork is generated on request from the completed track's prompt at 256×256 and can be regenerated", async () => {
	const f = musicFixture("success");
	const h = await harness({ model: f.model, musicGateway: f.gateway });
	try {
		const submitted = await (
			await h.request("/api/runs", {
				requestId: crypto.randomUUID(),
				conversationId: "main",
				text: musicQuestion,
			})
		).json();
		await h.dialogue.waitForTerminal(submitted.id, { timeoutMs: 5000 });
		const music = h.music!.list("main")[0]!;
		expect(music.state).toBe("completed");
		expect(music.artwork).toBeUndefined();
		expect(f.requests.some((r) => r.path === "/v1/images/generations")).toBe(
			false,
		);
		expect((await h.request(`/api/music/${music.id}/artwork`)).status).toBe(
			404,
		);
		expect((await h.request("/api/music/missing/artwork", {})).status).toBe(
			404,
		);
		const generate = async (revision: number) => {
			const accepted = await h.request(`/api/music/${music.id}/artwork`, {});
			expect(accepted.status).toBe(202);
			expect((await accepted.json()).artwork).toEqual({
				state: "generating",
				revision,
				errorCode: null,
			});
			await waitFor(
				() => h.music!.get(music.id)?.artwork?.state !== "generating",
			);
			expect(h.music!.get(music.id)?.artwork).toEqual({
				state: "completed",
				revision,
				errorCode: null,
			});
		};
		await generate(1);
		const busy = await h.request(`/api/music/${music.id}/artwork`, {});
		expect(busy.status).toBe(202);
		expect((await h.request(`/api/music/${music.id}/artwork`, {})).status).toBe(
			409,
		);
		await waitFor(
			() => h.music!.get(music.id)?.artwork?.state !== "generating",
		);
		const image = f.requests.find((r) => r.path === "/v1/images/generations")!;
		expect(image.body).toMatchObject({ width: 256, height: 256 });
		const text = JSON.stringify(image.body);
		expect(text).toContain(musicTestPlan.prompt);
		expect(text).toContain(musicTestPlan.title);
		const content = await h.request(`/api/music/${music.id}/artwork`);
		expect(content.status).toBe(200);
		expect(content.headers.get("content-type")).toBe("image/png");
		expect(new Uint8Array(await content.arrayBuffer())).toEqual(f.artwork);
		// The playlist reaches the same artwork through the LARM track id.
		expect(music.jobId).toBe("track");
		const linked = await h.request("/api/music/tracks/track/generation");
		expect(linked.status).toBe(200);
		expect(await linked.json()).toEqual({
			id: music.id,
			task: "music",
			runtime: "fixture-runtime",
			artwork: { state: "completed", revision: 2, errorCode: null },
		});
		expect(
			(await h.request("/api/music/tracks/larm-only/generation")).status,
		).toBe(404);
		await generate(3);
		expect(
			f.requests.filter((r) => r.path === "/v1/images/generations"),
		).toHaveLength(3);
		expect(
			f.requests.filter(
				(r) =>
					r.path === "/v1/image-artifacts/artwork" && r.method === "DELETE",
			),
		).toHaveLength(3);
	} finally {
		await h.close();
	}
});
test("artwork is refused for an unfinished track and a provider failure is recorded", async () => {
	const f = musicFixture("failure");
	const h = await harness({ model: f.model, musicGateway: f.gateway });
	try {
		const submitted = await (
			await h.request("/api/runs", {
				requestId: crypto.randomUUID(),
				conversationId: "main",
				text: musicQuestion,
			})
		).json();
		await h.dialogue.waitForTerminal(submitted.id, { timeoutMs: 5000 });
		const music = h.music!.list("main")[0]!;
		expect(music.state).toBe("failed");
		const refused = await h.request(`/api/music/${music.id}/artwork`, {});
		expect(refused.status).toBe(409);
		expect(await refused.json()).toEqual({ error: "music_not_completed" });
	} finally {
		await h.close();
	}
	const ok = musicFixture("success", { artworkFailure: true });
	const g = await harness({ model: ok.model, musicGateway: ok.gateway });
	try {
		const submitted = await (
			await g.request("/api/runs", {
				requestId: crypto.randomUUID(),
				conversationId: "main",
				text: musicQuestion,
			})
		).json();
		await g.dialogue.waitForTerminal(submitted.id, { timeoutMs: 5000 });
		const music = g.music!.list("main")[0]!;
		expect((await g.request(`/api/music/${music.id}/artwork`, {})).status).toBe(
			202,
		);
		await waitFor(
			() => g.music!.get(music.id)?.artwork?.state !== "generating",
		);
		expect(g.music!.get(music.id)?.artwork).toMatchObject({
			state: "failed",
			revision: 1,
		});
		expect(g.music!.get(music.id)?.artwork?.errorCode).toMatch(/^[a-z_0-9]+$/);
		expect((await g.request(`/api/music/${music.id}/artwork`)).status).toBe(
			404,
		);
	} finally {
		await g.close();
	}
});

test("a music screen submit generates a track though the conversation earlier used only another toolchain", async () => {
	const music = musicFixture("success");
	const image = imageFixture("success");
	let phase: "image" | "screen" = "image";
	let screenAnalysis = 0;
	const model = {
		...music.model,
		answer: async (...args: Parameters<typeof music.model.answer>) => {
			if (phase === "image") return image.model.answer(...args);
			if (isUtteranceRound(args[2])) screenAnalysis++;
			return music.model.answer(...args);
		},
	};
	const h = await harness({
		model,
		musicGateway: music.gateway,
		imageGateway: image.gateway,
	});
	try {
		const earlier = await (
			await h.request("/api/runs", {
				requestId: crypto.randomUUID(),
				conversationId: "main",
				text: imageQuestion,
			})
		).json();
		expect(
			(await h.dialogue.waitForTerminal(earlier.id, { timeoutMs: 5000 }))
				?.status,
		).toBe("completed");
		expect(h.image!.list("main")).toHaveLength(1);
		phase = "screen";
		const submitted = await (
			await h.request("/api/runs", {
				requestId: crypto.randomUUID(),
				conversationId: "main",
				text: musicQuestion,
				presentation: "artifact",
				toolchainId: "music.create",
			})
		).json();
		expect(submitted.pinnedToolchainId).toBe("music.create");
		expect(
			(await h.dialogue.waitForTerminal(submitted.id, { timeoutMs: 5000 }))
				?.status,
		).toBe("completed");
		expect(h.music!.list("main")).toHaveLength(1);
		expect(h.music!.list("main")[0]!.state).toBe("completed");
		// The screen's own toolchain took the request: no selection round, and no image was made for it.
		expect(screenAnalysis).toBe(0);
		expect(music.stages).toEqual(["plan"]);
		expect(h.image!.list("main")).toHaveLength(1);
		expect(music.requests.filter((r) => r.method === "POST")).toHaveLength(1);
	} finally {
		await h.close();
	}
});
