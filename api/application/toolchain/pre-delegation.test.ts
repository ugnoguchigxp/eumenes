import { expect, test } from "bun:test";
import { harness } from "./toolchain.fixture";
import { waitFor } from "../../infrastructure/wait-for";

test("research announces before the worker, retains the notice over API reads, then returns an answer", async () => {
	const h = await harness();
	let stop = () => {};
	try {
		const run = await h.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: "今日の東京の天気を調べて",
		});
		const observations: number[] = [];
		stop = h.dialogue.subscribeProgress(run.id, (p) => {
			if (p.announcement) observations.push(h.workerContexts.length);
		});
		expect(
			(await h.dialogue.waitForTerminal(run.id, { timeoutMs: 5000 }))?.status,
		).toBe("completed");
		expect(observations[0]).toBe(0);
		const final = await (await h.request(`/api/runs/${run.id}`)).json();
		expect(final.announcement).toBe("お調べします。");
		expect(h.dialogue.answerText(run.id)).toContain("晴れ");
		expect(h.conversation.get("main").messages).toHaveLength(2);
		expect(h.workerContexts.length).toBeGreaterThan(0);
	} finally {
		stop();
		await h.close();
	}
});

for (const notice of ["お調べします。", "お調べします"])
	test(`voice waits for notice playback: ${notice}`, async () => {
		const h = await harness({
			announcement: notice,
			parentAnswer: "東京は晴れです。",
			voiceText: "東京の天気を調べて",
		});
		try {
			const session = crypto.randomUUID(),
				utterance = crypto.randomUUID();
			const wav = new Uint8Array(48);
			wav.set(new TextEncoder().encode("RIFF"));
			wav.set(new TextEncoder().encode("WAVE"), 8);
			h.voice.start(session, 1);
			await h.voice.accept(session, 1, 1, utterance, wav);
			await waitFor(() => h.voice.get(utterance)?.status === "input_ready", {
				timeout: 1000,
			}).catch(() => {
				throw new Error(
					`input stage: ${JSON.stringify(h.voice.get(utterance))}`,
				);
			});
			await h.voice.commit(utterance, h.voice.get(utterance)!.revision);
			await waitFor(() => !!h.voice.get(utterance)?.audioChunks?.length);
			expect(h.workerContexts).toHaveLength(0);
			expect(h.acquisitions).toBe(0);
			expect(h.voice.get(utterance)?.audioChunks?.[0]?.text).toBe(notice);
			await h.voice.played(
				utterance,
				h.voice.get(utterance)!.audioChunks![0]!.index,
			);
			await waitFor(
				() =>
					["ready", "failed"].includes(h.voice.get(utterance)?.status ?? ""),
				{ timeout: 2000 },
			).catch(() => {
				throw new Error(
					`speech stage: ${JSON.stringify({ turn: h.voice.get(utterance), spoken: h.spoken })}`,
				);
			});
			const turn = h.voice.get(utterance)!;
			expect(turn.status).toBe("ready");
			expect(h.spoken[0]).toBe(notice);
			expect(h.spoken.filter((text) => text === notice)).toHaveLength(1);
			expect(h.spoken.join("")).toContain("晴れ");
			expect(h.dialogue.answerText(turn.runId!)!).not.toContain(notice);
		} finally {
			await h.close();
		}
	});

test("cancelling during the spoken notice never starts the research worker", async () => {
	const h = await harness({ voiceText: "鎌倉の天気を調べて" });
	try {
		const session = crypto.randomUUID(),
			id = crypto.randomUUID();
		const wav = new Uint8Array(48);
		wav.set(new TextEncoder().encode("RIFF"));
		wav.set(new TextEncoder().encode("WAVE"), 8);
		h.voice.start(session, 1);
		await h.voice.accept(session, 1, 1, id, wav);
		await waitFor(() => h.voice.get(id)?.status === "input_ready");
		await h.voice.commit(id, h.voice.get(id)!.revision);
		await waitFor(() => !!h.voice.get(id)?.audioChunks?.length);
		expect(h.workerContexts).toHaveLength(0);
		await h.voice.cancel(id);
		const runId = h.voice.get(id)!.runId!;
		expect((await h.dialogue.waitForTerminal(runId))?.status).toBe("cancelled");
		expect(h.workerContexts).toHaveLength(0);
		expect(h.acquisitions).toBe(0);
	} finally {
		await h.close();
	}
});

test("an unspoken notice cannot authorize the research worker", async () => {
	const h = await harness({ voiceText: "天気を調べて", speechFailure: true });
	try {
		const session = crypto.randomUUID(),
			id = crypto.randomUUID();
		const wav = new Uint8Array(48);
		wav.set(new TextEncoder().encode("RIFF"));
		wav.set(new TextEncoder().encode("WAVE"), 8);
		h.voice.start(session, 1);
		await h.voice.accept(session, 1, 1, id, wav);
		await waitFor(() => h.voice.get(id)?.status === "input_ready");
		await h.voice.commit(id, h.voice.get(id)!.revision);
		await waitFor(() => h.voice.get(id)?.status === "failed");
		expect(h.workerContexts).toHaveLength(0);
		expect(h.acquisitions).toBe(0);
		expect(h.voice.get(id)?.audioChunks).toEqual([]);
	} finally {
		await h.close();
	}
});
