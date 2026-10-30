import { expect, test } from "bun:test";
import type { LarmPort } from "../../larm";
import { systemContext } from "../../../infrastructure/system-context";
import { setup, say, until, wav } from "./settings-voice.fixture";

/**
 * The local harness's routed turn on the real request lifecycle (the local harness rebuild plan, section 4.5): one
 * turn makes several calls on its one answer request, and a call that fails or says nothing ends only that call. What
 * the host says then is the run's answer, and the voice turn speaks it instead of failing `permission_revoked`.
 */
const FAILED = systemContext("dialogue.contexts.local.turn-failed", {});
const NONE = JSON.stringify({ choice: "none" });
const ENDED = ["ready", "played", "completed", "failed", "cancelled"];

async function turnOf(
	talk: LarmPort["answerStream"],
	choose: () => Promise<string>,
) {
	const spoken: string[] = [];
	const h = await setup(
		undefined,
		{
			transcribe: async () => "こんにちは。",
			answerStream: talk,
			speak: async (text) => {
				spoken.push(text);
				return wav();
			},
		},
		choose,
	);
	const id = crypto.randomUUID(),
		session = crypto.randomUUID();
	h.voice.start(session, 1);
	await say(h, session, id);
	await until(() => ENDED.includes(h.voice.get(id)?.status ?? ""));
	return { h, turn: h.voice.get(id)!, spoken };
}
const saying =
	(text: string): LarmPort["answerStream"] =>
	async (_messages, _signal, onDelta) => {
		onDelta(text);
		return text;
	};
const failing =
	(code: string): LarmPort["answerStream"] =>
	async () => {
		throw new Error(code);
	};

test("a talk that ends with nothing in it gets the host's words, and the voice turn speaks them", async () => {
	const { h, turn } = await turnOf(failing("chat_output_empty"), async () => {
		throw new Error("chat_output_empty");
	});
	expect(turn.error).toBeNull();
	expect(turn.status).toBe("ready");
	expect(h.dialogue.answerText(turn.runId!)).toBe(FAILED);
	expect(h.dialogue.get(turn.runId!)?.status).toBe("completed");
});

test("a choice cut at the output limit passes to talk on the same request, and the voice turn speaks its answer", async () => {
	let chosen = 0;
	const { h, turn, spoken } = await turnOf(saying("こんにちは。"), async () => {
		if (chosen++ === 0) throw new Error("chat_stream_incomplete");
		return NONE;
	});
	expect(chosen).toBe(1);
	expect(turn.error).toBeNull();
	expect(turn.status).toBe("ready");
	expect(h.dialogue.answerText(turn.runId!)).toBe("こんにちは。");
	expect(h.dialogue.get(turn.runId!)?.status).toBe("completed");
	expect(spoken.join("")).toBe("こんにちは。");
});

test("a talk that fails before a word gets the host's words, and the voice turn speaks them", async () => {
	const { h, turn } = await turnOf(
		failing("chat_stream_too_large"),
		async () => NONE,
	);
	expect(turn.error).toBeNull();
	expect(turn.status).toBe("ready");
	expect(h.dialogue.answerText(turn.runId!)).toBe(FAILED);
});

test("a cut choice followed by a failed talk adopts and speaks the host's answer on the same request", async () => {
	let chosen = 0;
	const { h, turn, spoken } = await turnOf(
		failing("chat_stream_incomplete"),
		async () => {
			chosen++;
			throw new Error("chat_stream_incomplete");
		},
	);
	expect(chosen).toBe(1);
	expect(turn.error).toBeNull();
	expect(turn.status).toBe("ready");
	expect(h.dialogue.get(turn.runId!)?.status).toBe("completed");
	expect(h.dialogue.answerText(turn.runId!)).toBe(FAILED);
	expect(spoken.join("")).toBe(FAILED);
});
