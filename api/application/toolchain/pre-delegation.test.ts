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

test("voice speaks the notice once before the research answer, without replacing the answer", async () => {
	const h = await harness({
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
			throw new Error(`input stage: ${JSON.stringify(h.voice.get(utterance))}`);
		});
		await h.voice.commit(utterance, h.voice.get(utterance)!.revision);
		await waitFor(
			() => ["ready", "failed"].includes(h.voice.get(utterance)?.status ?? ""),
			{ timeout: 2000 },
		).catch(() => {
			throw new Error(
				`speech stage: ${JSON.stringify({ turn: h.voice.get(utterance), spoken: h.spoken })}`,
			);
		});
		const turn = h.voice.get(utterance)!;
		expect(turn.status).toBe("ready");
		expect(h.spoken[0]).toBe("お調べします。");
		expect(h.spoken.filter((text) => text === "お調べします。")).toHaveLength(
			1,
		);
		expect(h.spoken.join("")).toContain("晴れ");
		expect(h.dialogue.answerText(turn.runId!)!).not.toContain("お調べします。");
	} finally {
		await h.close();
	}
});
