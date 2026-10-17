import { afterEach, expect, test } from "bun:test";
import { configureLogging } from "../../infrastructure/logger";
import { RESEARCH_FAILURE_REPLY } from "../../domains/dialogue/service/research-failure-reply";
import { harness } from "./toolchain.fixture";
import { waitFor } from "../../infrastructure/wait-for";

afterEach(() => configureLogging({ level: "silent" }));
function wav() {
	const value = new Uint8Array(48);
	value.set(new TextEncoder().encode("RIFF"));
	value.set(new TextEncoder().encode("WAVE"), 8);
	return value;
}
async function until(check: () => boolean) {
	await waitFor(check);
	expect(check()).toBe(true);
}
async function accept(h: Awaited<ReturnType<typeof harness>>) {
	const session = crypto.randomUUID(),
		id = crypto.randomUUID();
	h.voice.start(session, 1);
	await h.voice.accept(session, 1, 1, id, wav());
	await until(() => h.voice.get(id)?.status !== "recognizing");
	const turn = h.voice.get(id)!;
	if (turn.status === "input_ready") await h.voice.commit(id, turn.revision);
	await until(
		() =>
			!!h.voice.get(id)?.runId ||
			["completed", "failed"].includes(h.voice.get(id)?.status ?? ""),
	);
	if (h.voice.get(id)?.runId && h.settings.get().voice.autoSpeak) {
		await until(
			() =>
				!!h.voice.get(id)?.audioChunks?.length ||
				h.voice.get(id)?.status === "failed",
		);
		const notice = h.voice.get(id)!.audioChunks?.[0];
		if (h.dialogue.get(h.voice.get(id)!.runId!)?.announcement) {
			expect(notice?.text).toBe("お調べします。");
			await h.voice.played(id, notice!.index);
		}
	}
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
	{ workerReportOutput: '{"action":' },
])
	test(`failed research is answered by the host and spoken without a model call: ${JSON.stringify(options)}`, async () => {
		const lines: string[] = [];
		configureLogging({
			level: "info",
			destination: {
				write: (line) => {
					lines.push(line);
				},
			},
		});
		const h = await harness({
			...options,
			fullResearch: true,
			voiceText: "今日の鎌倉の天気は",
		});
		try {
			const id = await accept(h);
			await until(() =>
				["ready", "failed"].includes(h.voice.get(id)?.status ?? ""),
			);
			expect(h.voice.get(id)?.status).toBe("ready");
			const runId = h.voice.get(id)!.runId!;
			expect(h.dialogue.answerText(runId)).toBe(RESEARCH_FAILURE_REPLY);
			expect(h.spoken).toEqual(["お調べします。", RESEARCH_FAILURE_REPLY]);
			expect(h.voice.takeAudio(id, 1)).toEqual(wav());
			expect(h.parentContexts).toEqual([]);
			const request = h.store.read((db) =>
				db
					.query(
						"SELECT status FROM inference_requests WHERE subject=? AND purpose='llm'",
					)
					.get(runId),
			);
			expect(request).toEqual({ status: "accepted" });
			const rows = lines.map((line) => JSON.parse(line));
			expect(
				rows.find((row) => row.event === "voice.synthesis_started"),
			).toMatchObject({ runId, utteranceId: id });
			expect(
				rows.find((row) => row.event === "voice.synthesis_completed"),
			).toMatchObject({ runId, count: 1 });
			expect(lines.join("")).not.toContain("鎌倉");
		} finally {
			await h.close();
		}
	});

test("a failed research honours autoSpeak=false: the host answer is adopted and nothing is spoken", async () => {
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
		expect(h.dialogue.answerText(h.voice.get(id)!.runId!)).toBe(
			RESEARCH_FAILURE_REPLY,
		);
		expect(h.parentContexts).toEqual([]);
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
		expect(h.spoken).toEqual([
			"お調べします。",
			h.dialogue.answerText(h.voice.get(id)!.runId!)!,
		]);
		expect(h.spoken[1]).toContain("180秒");
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
