import { afterEach, expect, test } from "bun:test";
import { configureLogging } from "../infrastructure/logger";
import { settle, waitFor } from "../infrastructure/wait-for";
import { harness, workerPacket } from "./toolchain.fixture";

afterEach(() => configureLogging({ level: "silent" }));
const answer =
	"本文を確認しました。気温は26度です。雨の予報はありません。確認は以上です。";
function research(messages: Parameters<typeof workerPacket>[0]) {
	const data = workerPacket(messages);
	const page = data.observations.find(
		(observation: { basis: string }) => observation.basis === "page",
	);
	if (page)
		return JSON.stringify({
			action: "finish",
			report: {
				completion: "complete",
				answer,
				summary: page.excerpts[0].quote,
				claims: [
					{
						text: page.excerpts[0].quote,
						status: "verified",
						evidence: [page.excerpts[0].reference],
					},
				],
				limitations: [],
			},
		});
	const candidate = data.candidates?.[0];
	if (candidate)
		return JSON.stringify({
			action: "invoke",
			tool: "web.read",
			arguments: { url: candidate.url },
		});
	return JSON.stringify({
		action: "invoke",
		tool: "web.lookup",
		arguments: { query: "天気" },
	});
}
async function start(h: Awaited<ReturnType<typeof harness>>) {
	const sessionId = crypto.randomUUID(),
		id = crypto.randomUUID();
	h.voice.start(sessionId, 1);
	const wav = new Uint8Array(48);
	wav.set(new TextEncoder().encode("RIFF"));
	wav.set(new TextEncoder().encode("WAVE"), 8);
	await h.voice.accept(sessionId, 1, 1, id, wav);
	await waitFor(() => h.voice.get(id)?.status === "input_ready");
	await h.voice.commit(id, h.voice.get(id)!.revision);
	await waitFor(
		() =>
			!!h.voice.get(id)?.audioChunks.length ||
			h.voice.get(id)?.status === "failed",
	);
	return id;
}

test("a verified research answer adopts the final LLM receipt and delivers every audio chunk through HTTP to played", async () => {
	const h = await harness({
		fullResearch: true,
		voiceText: "今日の天気を調べて",
		control: research,
		parentAnswer: answer,
	});
	try {
		const id = await start(h),
			runId = h.voice.get(id)!.runId!;
		expect(h.voice.get(id)?.error).toBeNull();
		expect(h.dialogue.get(runId)?.status).toBe("completed");
		expect(h.parentContexts).toHaveLength(1);
		const parent = h.store.read((db) =>
			h.inference.requestFor(db, runId, "llm"),
		)!;
		expect(h.inference.validRequest(parent)).toBe(true);
		expect(h.inference.liveRequest(parent)).toBe(true);
		let count = 0;
		await waitFor(async () => {
			const turn = h.voice.get(id)!;
			expect(turn.status).not.toBe("failed");
			for (const chunk of turn.audioChunks) {
				const audio = await h.request(
					`/api/voice/turns/${id}/audio?index=${chunk.index}`,
				);
				expect(audio.status).toBe(200);
				expect(audio.headers.get("content-type")).toContain("audio/wav");
				const bytes = new Uint8Array(await audio.arrayBuffer());
				expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe("RIFF");
				const played = await h.request(
					`/api/voice/turns/${id}/played?index=${chunk.index}`,
					{},
				);
				expect(played.status).toBe(200);
				count++;
			}
			return h.voice.get(id)?.status === "played";
		});
		expect(count).toBe(4);
		expect(h.spoken.join("")).toBe(answer);
		expect(h.voice.get(id)?.audioComplete).toBe(true);
		expect(
			(await h.request(`/api/voice/turns/${id}/audio?index=0`)).status,
		).toBe(404);
	} finally {
		await h.close();
	}
});

for (const action of ["cancel", "revoke"] as const)
	test(`guided speech cannot publish or serve the remaining audio after ${action}`, async () => {
		const h = await harness({
			fullResearch: true,
			voiceText: "今日の天気を調べて",
			control: research,
			parentAnswer: answer,
		});
		try {
			const id = await start(h);
			await waitFor(
				() =>
					h.voice.get(id)?.audioChunks.length === 3 ||
					h.voice.get(id)?.status === "failed",
			);
			expect(h.voice.get(id)?.error).toBeNull();
			if (action === "cancel") await h.voice.cancel(id);
			else {
				const parent = h.store.read((db) =>
					h.inference.requestFor(db, h.voice.get(id)!.runId!, "llm"),
				)!;
				await h.store.write((db) =>
					db
						.query(
							"UPDATE inference_requests SET status='cancelled' WHERE id=?",
						)
						.run(parent),
				);
				expect(h.inference.liveRequest(parent)).toBe(false);
			}
			expect(
				(await h.request(`/api/voice/turns/${id}/audio?index=0`)).status,
			).toBe(404);
			await h.voice.played(id, 0);
			await settle();
			expect(h.spoken).toHaveLength(3);
			expect(
				h.voice.get(id)?.audioChunks.some((chunk) => chunk.index >= 3),
			).toBe(false);
		} finally {
			await h.close();
		}
	});
