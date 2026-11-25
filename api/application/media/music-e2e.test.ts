import { expect, test } from "bun:test";
import { musicFixture, musicQuestion, musicTestPlan } from "./music.fixture";
import { imageFixture, imageQuestion } from "./image.fixture";
import {
	ask,
	assignmentAgenda,
	cancelAssignment,
	ended,
	executions,
	items,
	notes,
	plannedBy,
	reportLine,
	resources,
	until,
	works,
} from "./assignment.fixture";

const tracks = (f: ReturnType<typeof musicFixture>) =>
	f.requests.filter((r) => r.method === "POST");
const agenda = (f: ReturnType<typeof musicFixture>) =>
	assignmentAgenda({
		harness: { model: plannedBy({ music: f }), musicGateway: f.gateway },
	});

for (const mode of [
	"success",
	"failure",
	"invalid-plan",
	"correctable-plan",
] as const)
	test(`music pipeline ${mode}: assignment, worker, API, result, audio`, async () => {
		const f = musicFixture(mode);
		const a = await agenda(f);
		try {
			await a.start();
			await ask(a, "music.create", musicQuestion);
			await until(a, () => ended(a));
			expect(executions(a)).toHaveLength(1);
			expect(works(a)[0]!.execution_id).toBe(executions(a)[0]!.id);
			const records = await (
				await a.h.request("/api/music?conversationId=ao")
			).json();
			expect(records).toHaveLength(1);
			const music = records[0];
			const success = mode === "success" || mode === "correctable-plan";
			expect(music.state).toBe(success ? "completed" : "failed");
			const posts = tracks(f);
			expect(posts).toHaveLength(mode === "invalid-plan" ? 0 : 1);
			expect(f.stages).toEqual(["plan"]);
			const response = await a.h.request(`/api/music/${music.id}/audio`);
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
				// The agent reports the finished work: a note, and a line that carries the track.
				await until(a, () => !!reportLine(a));
				expect(notes(a)).toHaveLength(1);
				expect(items(a)).toHaveLength(0);
			} else {
				expect(response.status).toBe(404);
				expect(music.errorCode).toBe(
					mode === "failure"
						? "generation_unknown"
						: "music_plan_invalid_contract",
				);
			}
		} finally {
			await a.close();
		}
	}, 30_000);
test("cancelling the assignment while the provider is running cancels the track and never adopts audio", async () => {
	const f = musicFixture("cancel");
	const a = await agenda(f);
	try {
		await a.start();
		const { id } = await ask(a, "music.create", musicQuestion);
		await until(a, () => !!a.h.music!.list("ao")[0]?.jobId);
		expect(a.h.music!.list("ao")[0]?.jobId).toBe("track");
		await cancelAssignment(a, id);
		await until(a, () => a.h.music!.list("ao")[0]?.state === "cancelled");
		expect(
			(await a.h.request(`/api/music/${a.h.music!.list("ao")[0]!.id}/audio`))
				.status,
		).toBe(404);
		expect(tracks(f)).toHaveLength(1);
		expect(executions(a)[0]).toMatchObject({ status: "cancelled" });
		expect(items(a)).toHaveLength(0);
		expect(f.stages).toEqual(["plan"]);
	} finally {
		await a.close();
	}
}, 30_000);
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
	const a = await agenda(f);
	try {
		await a.start();
		await ask(a, "music.create", question);
		await until(a, () => ended(a));
		const music = a.h.music!.list("ao")[0]!;
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
		await a.close();
	}
}, 30_000);
test("artwork is generated on request from the completed track's prompt at 256×256 and can be regenerated", async () => {
	const f = musicFixture("success");
	const a = await agenda(f);
	const h = a.h;
	try {
		await a.start();
		await ask(a, "music.create", musicQuestion);
		await until(a, () => ended(a));
		const music = h.music!.list("ao")[0]!;
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
			await until(
				a,
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
		await until(
			a,
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
		await a.close();
	}
}, 30_000);
test("artwork is refused for an unfinished track and a provider failure is recorded", async () => {
	const f = musicFixture("failure");
	const a = await agenda(f);
	try {
		await a.start();
		await ask(a, "music.create", musicQuestion);
		await until(a, () => ended(a));
		const music = a.h.music!.list("ao")[0]!;
		expect(music.state).toBe("failed");
		const refused = await a.h.request(`/api/music/${music.id}/artwork`, {});
		expect(refused.status).toBe(409);
		expect(await refused.json()).toEqual({ error: "music_not_completed" });
	} finally {
		await a.close();
	}
	const ok = musicFixture("success", { artworkFailure: true });
	const g = await agenda(ok);
	try {
		await g.start();
		await ask(g, "music.create", musicQuestion);
		await until(g, () => ended(g));
		const music = g.h.music!.list("ao")[0]!;
		expect(
			(await g.h.request(`/api/music/${music.id}/artwork`, {})).status,
		).toBe(202);
		await until(
			g,
			() => g.h.music!.get(music.id)?.artwork?.state !== "generating",
		);
		expect(g.h.music!.get(music.id)?.artwork).toMatchObject({
			state: "failed",
			revision: 1,
		});
		expect(g.h.music!.get(music.id)?.artwork?.errorCode).toMatch(
			/^[a-z_0-9]+$/,
		);
		expect((await g.h.request(`/api/music/${music.id}/artwork`)).status).toBe(
			404,
		);
	} finally {
		await g.close();
	}
}, 30_000);

test("a music assignment starts though the conversation earlier used only another toolchain", async () => {
	const music = musicFixture("success");
	const image = imageFixture("success");
	const a = await assignmentAgenda({
		media: image,
		harness: {
			model: plannedBy({ image, music }),
			musicGateway: music.gateway,
		},
		catalog: (id) =>
			id.startsWith("toolchain:image.create@") ||
			id.startsWith("toolchain:music.create@"),
	});
	try {
		await a.start();
		await ask(a, "image.create", imageQuestion);
		await until(a, () => ended(a));
		expect(a.h.image!.list("ao")).toHaveLength(1);
		await ask(a, "music.create", musicQuestion);
		await until(a, () => ended(a, 2));
		expect(a.h.music!.list("ao")).toHaveLength(1);
		expect(a.h.music!.list("ao")[0]!.state).toBe("completed");
		// Each assignment started its own toolchain: no second image was made for the track.
		expect(music.stages).toEqual(["plan"]);
		expect(a.h.image!.list("ao")).toHaveLength(1);
		expect(tracks(music)).toHaveLength(1);
	} finally {
		await a.close();
	}
}, 30_000);

test("LARM's free-memory refusal puts the music into a wait: one POST, assignment kept open, cancel stops it", async () => {
	const f = musicFixture("success", { capacityRefusal: true });
	const a = await agenda(f);
	const posts = () =>
		f.requests.filter(
			(r) => r.method === "POST" && r.path === "/v1/music/generations",
		);
	try {
		await a.start();
		const { id } = await ask(a, "music.create", musicQuestion);
		await until(
			a,
			() => a.h.music!.list("ao")[0]?.phase === "waiting_capacity",
		);
		const record = a.h.music!.list("ao")[0]!;
		expect(record).toMatchObject({ state: "generating", jobId: null });
		expect(record.capacityWait?.count).toBe(1);
		expect(posts()).toHaveLength(1);
		// The assignment stays open while the track waits: still an item of the agent, not ended at its owner.
		expect(items(a)).toHaveLength(1);
		expect(ended(a)).toBe(false);
		await cancelAssignment(a, id);
		await until(a, () => a.h.music!.list("ao")[0]!.state === "cancelled");
		await Bun.sleep(50);
		expect(posts()).toHaveLength(1);
		// No job was accepted by LARM, so there is nothing to DELETE there.
		expect(
			f.requests.some(
				(r) => r.method === "DELETE" && r.path.endsWith("/track"),
			),
		).toBe(false);
	} finally {
		await a.close();
	}
}, 30_000);

test("the generated Ogg Opus track is reported once, with the track as the report's resource, in its originating conversation only", async () => {
	const f = musicFixture("success");
	const a = await assignmentAgenda({
		harness: { model: plannedBy({ music: f }), musicGateway: f.gateway },
	});
	try {
		await a.start();
		await ask(a, "music.create", musicQuestion);
		await until(a, () => ended(a));
		await until(a, () => !!reportLine(a));
		expect(notes(a)).toHaveLength(1);
		const made = await resources(a);
		expect(made.resources).toMatchObject([
			{ kind: "music.track", uri: "eumenes://music.track/track" },
		]);
		expect(made.messages).toContainEqual(
			expect.objectContaining({ messageId: reportLine(a)!.id }),
		);
		const unrelated = await (
			await a.h.request("/api/conversations/main/resources")
		).json();
		expect(unrelated.resources).toEqual([]);
		const audio = await a.h.request(
			`/api/music/${a.h.music!.list("ao")[0]!.id}/audio`,
		);
		expect(audio.headers.get("content-type")).toBe("audio/ogg");
		expect(new Uint8Array(await audio.arrayBuffer())).toEqual(f.audio);
		expect(f.stages).toEqual(["plan"]);
	} finally {
		await a.close();
	}
}, 30_000);
