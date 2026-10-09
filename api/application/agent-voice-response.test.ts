import { afterEach, expect, test } from "bun:test";
import { configureLogging } from "../infrastructure/logger";
import { harness, forbidden } from "./toolchain.fixture";

afterEach(() => configureLogging({ level: "silent" }));
function wav() {
	const value = new Uint8Array(48);
	value.set(new TextEncoder().encode("RIFF"));
	value.set(new TextEncoder().encode("WAVE"), 8);
	return value;
}
async function until(check: () => boolean) {
	for (let i = 0; i < 1000 && !check(); i++) await Bun.sleep(5);
	expect(check()).toBe(true);
}
async function accept(h: Awaited<ReturnType<typeof harness>>) {
	const session = crypto.randomUUID(),
		id = crypto.randomUUID();
	h.voice.start(session, 1);
	await h.voice.accept(session, 1, 1, id, wav());
	return id;
}
test("silence completes without creating a dialogue, cancelling another run or synthesizing speech", async () => {
	const h = await harness({ voiceText: " " });
	try {
		const id = await accept(h);
		await until(() => h.voice.get(id)?.status === "completed");
		expect(h.voice.get(id)).toMatchObject({
			text: "",
			runId: null,
			error: null,
		});
		expect(h.calls).toBe(0);
		expect(h.spoken).toEqual([]);
	} finally {
		await h.close();
	}
});

for (const options of [
	{ badJson: true },
	{ badQuote: true },
	{ lookupTimeoutOnce: true, workerReportOutput: '{"action":' },
])
	test(`failed research generates and adopts the agent's response before TTS: ${JSON.stringify(options)}`, async () => {
		const lines: string[] = [];
		configureLogging({
			level: "info",
			destination: {
				write: (line) => {
					lines.push(line);
				},
			},
		});
		const answer = "わたくしの調査では確認できませんでした。";
		const h = await harness({
			...options,
			voiceText: "今日の鎌倉の天気は",
			failureAnswer: answer,
		});
		try {
			const id = await accept(h);
			await until(() =>
				["ready", "failed"].includes(h.voice.get(id)?.status ?? ""),
			);
			expect(h.voice.get(id)?.status).toBe("ready");
			const runId = h.voice.get(id)!.runId!;
			expect(h.dialogue.answerText(runId)).toBe(answer);
			expect(h.spoken).toEqual([answer]);
			expect(h.voice.takeAudio(id)).toEqual(wav());
			expect(h.parentContexts).toHaveLength(1);
			expect(h.parentContexts[0]).not.toContain(forbidden);
			expect(h.parentContexts[0]).not.toContain('"quote"');
			const request = h.store.read((db) =>
				db
					.query(
						"SELECT status FROM inference_requests WHERE subject=? AND purpose='llm'",
					)
					.get(runId),
			);
			expect(request).toEqual({ status: "accepted" });
			const dataMessage = JSON.parse(h.parentContexts[0]!).find(
				(message: { content: string }) =>
					message.content.includes('"researchProgress":'),
			);
			const data = JSON.parse(
				dataMessage.content.slice(dataMessage.content.indexOf("{")),
			);
			expect(data.researchProgress.verifiedReport).toBe(false);
			if (options.lookupTimeoutOnce) {
				expect(data.researchProgress).toMatchObject({
					searchAttempts: 2,
					searchesSucceeded: 1,
					readAttempts: 1,
					readsSucceeded: 1,
				});
			}
			const rows = lines.map((line) => JSON.parse(line));
			expect(
				rows.find((row) => row.event === "voice.synthesis_started"),
			).toMatchObject({ runId, utteranceId: id });
			expect(
				rows.find((row) => row.event === "voice.synthesis_completed"),
			).toMatchObject({ runId, count: 1 });
			expect(lines.join("")).not.toContain(answer);
			expect(lines.join("")).not.toContain("鎌倉");
		} finally {
			await h.close();
		}
	});

test("cancelling while the agent phrases a failure discards the late response and never speaks", async () => {
	let release!: () => void;
	const h = await harness({
		badJson: true,
		voiceText: "東京の天気を調べて",
		answerGate: new Promise<void>((r) => {
			release = r;
		}),
	});
	try {
		const id = await accept(h);
		await until(() => h.parentContexts.length === 1);
		const runId = h.voice.get(id)!.runId!;
		await h.voice.cancel(id);
		release();
		await until(() => h.queue.stats().resources["inference.llm"]!.inUse === 0);
		expect(h.voice.get(id)?.status).toBe("cancelled");
		expect(h.dialogue.answerText(runId)).toBeNull();
		expect(h.spoken).toEqual([]);
		expect(h.voice.takeAudio(id)).toBeNull();
	} finally {
		release();
		await h.close();
	}
});

test("failure response honours autoSpeak=false without bypassing the agent", async () => {
	const h = await harness({ badJson: true, voiceText: "東京の天気を調べて" });
	try {
		const settings = h.settings.get();
		settings.voice.autoSpeak = false;
		await h.settings.apply({
			requestId: crypto.randomUUID(),
			expectedRevision: settings.revision,
			settings,
			keys: [],
		});
		const id = await accept(h);
		await until(() =>
			["completed", "failed"].includes(h.voice.get(id)?.status ?? ""),
		);
		expect(h.voice.get(id)?.status).toBe("completed");
		expect(h.parentContexts).toHaveLength(1);
		expect(h.spoken).toEqual([]);
	} finally {
		await h.close();
	}
});

test("a committed timer result follows the agent generation and speech path without executing twice", async () => {
	const h = await harness({ timers: true, voiceText: "3分タイマー測って" });
	try {
		const id = await accept(h);
		await until(() =>
			["ready", "failed"].includes(h.voice.get(id)?.status ?? ""),
		);
		expect(h.voice.get(id)?.status).toBe("ready");
		expect(h.parentContexts).toHaveLength(1);
		expect(h.spoken).toEqual([h.dialogue.answerText(h.voice.get(id)!.runId!)!]);
		expect(h.spoken[0]).toContain("3分");
		expect(
			h.store.read((db) =>
				db
					.query(
						"SELECT COUNT(*) AS n FROM timer_operations WHERE operation='start'",
					)
					.get(),
			),
		).toEqual({ n: 1 });
	} finally {
		await h.close();
	}
});
