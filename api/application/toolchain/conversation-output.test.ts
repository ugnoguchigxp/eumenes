import { afterEach, expect, test } from "bun:test";
import { harness } from "./toolchain.fixture";
import { isUtteranceRound } from "../toolchain/conversation-script.fixture";
import { musicFixture } from "../media/music.fixture";
import type { LarmPort } from "../../domains/larm";
import { configureLogging } from "../../infrastructure/logger";
import { waitFor } from "../../infrastructure/wait-for";

afterEach(() => configureLogging({ level: "silent" }));
const control =
	'create_music{question:<|"|>夜にふさわしい、しっとりとした落ち着いた雰囲気の楽曲。2分間。<|"|>}';
const wave = () => {
	const wav = new Uint8Array(48);
	wav.set(new TextEncoder().encode("RIFF"));
	wav.set(new TextEncoder().encode("WAVE"), 8);
	return wav;
};
async function until(check: () => boolean) {
	await waitFor(check);
	expect(check()).toBe(true);
}
test("voice does not display, persist or speak text-only control output: the run fails without a repair", async () => {
	const f = musicFixture();
	const spoken: string[] = [],
		visible: string[] = [];
	let routes = 0,
		waiting = false,
		release!: () => void;
	const pause = new Promise<void>((resolve) => {
		release = resolve;
	});
	const model: LarmPort = {
		...f.model,
		status: () => ({ state: "ready", capabilities: ["llm", "asr", "tts"] }),
		transcribe: async () => "何か夜でしっとりしたような。",
		speak: async (text) => {
			spoken.push(text);
			return wave();
		},
		answer: async (messages, signal, options) =>
			messages[0]!.content.includes("転記された発話の主要な言語")
				? JSON.stringify({
						status: "identified",
						languages: ["ja"],
						confidence: 0.99,
					})
				: f.model.answer(messages, signal, options),
		answerStream: async (messages, signal, delta, options) => {
			const utterance = isUtteranceRound(options);
			if (utterance) {
				// Control text beside no tool call: it is withdrawn, and the generation fails (nothing asks for a repair).
				routes++;
				for (const character of control) delta(character);
				waiting = true;
				await pause;
				return control;
			}
			const answer = await f.model.answer(messages, signal, options);
			delta(answer);
			return answer;
		},
	};
	const h = await harness({ model, musicGateway: f.gateway });
	let stop = () => {};
	try {
		const session = crypto.randomUUID(),
			id = crypto.randomUUID();
		h.voice.start(session, 1);
		await h.voice.accept(session, 1, 1, id, wave());
		await until(() => h.voice.get(id)?.status === "input_ready");
		await h.voice.commit(id, h.voice.get(id)!.revision);
		await until(() => waiting && !!h.voice.get(id)?.runId);
		const runId = h.voice.get(id)!.runId!;
		stop = h.dialogue.subscribeProgress(runId, (progress) =>
			visible.push(progress.text),
		);
		expect(h.dialogue.progress(runId)?.text).toBe("");
		expect(spoken).toEqual([]);
		release();
		await until(() =>
			["ready", "failed"].includes(h.voice.get(id)?.status ?? ""),
		);
		expect(routes).toBe(1);
		expect(
			visible.every(
				(text) => !text.includes("create_music") && !text.includes("<|"),
			),
		).toBe(true);
		expect(
			h.conversation
				.get("main")
				.messages.every((m) => !m.text.includes(control)),
		).toBe(true);
		expect(h.dialogue.get(runId)?.status).toBe("failed");
		expect(h.dialogue.answerText(runId)).toBeNull();
		expect(h.music!.list("main")).toEqual([]);
		expect(f.requests.filter((r) => r.method === "POST")).toHaveLength(0);
		expect(spoken).toEqual([]);
	} finally {
		release();
		stop();
		await h.close();
	}
});
