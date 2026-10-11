import { expect, test } from "bun:test";
import { harness } from "./toolchain.fixture";
import { musicFixture, musicQuestion, musicTestPlan } from "./music.fixture";
for (const mode of ["success", "failure", "invalid-plan"] as const)
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
			expect(music.state).toBe(mode === "success" ? "completed" : "failed");
			const posts = f.requests.filter((r) => r.method === "POST");
			expect(posts).toHaveLength(mode === "invalid-plan" ? 0 : 1);
			expect(f.stages).toEqual(["route", "plan", "answer"]);
			const response = await h.request(`/api/music/${music.id}/audio`);
			if (mode === "success") {
				expect(posts[0]!.body).toMatchObject({
					prompt: musicTestPlan.prompt,
					durationSeconds: 30,
					instrumental: true,
				});
				expect(response.status).toBe(200);
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
