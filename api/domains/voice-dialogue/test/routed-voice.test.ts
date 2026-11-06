import { expect, test } from "bun:test";
import { systemContext } from "../../../infrastructure/system-context";
import type { LarmPort } from "../../larm";
import {
	createSettingsVoiceFixture,
	say,
	until,
	wav,
} from "./settings-voice.fixture";
const { setup } = createSettingsVoiceFixture();

/**
 * The local harness's routed turn on the real request lifecycle (the local harness rebuild plan, section 4.5): a call
 * that fails or says nothing ends only that call. What the host says then is the run's answer, and the voice turn
 * speaks it instead of failing `permission_revoked`.
 */
const FAILED = systemContext("dialogue.contexts.local.turn-failed", {});
const ENDED = ["ready", "played", "completed", "failed", "cancelled"];

async function turnOf(talk: LarmPort["answerStream"]) {
	const h = await setup(undefined, {
		transcribe: async () => "こんにちは。",
		answerStream: talk,
		speak: async () => wav(),
	});
	const id = crypto.randomUUID(),
		session = crypto.randomUUID();
	h.voice.start(session, 1);
	await say(h, session, id);
	await until(() => ENDED.includes(h.voice.get(id)?.status ?? ""));
	return { h, turn: h.voice.get(id)! };
}
const failing =
	(code: string): LarmPort["answerStream"] =>
	async () => {
		throw new Error(code);
	};

test("a talk that ends with nothing in it gets the host's words, and the voice turn speaks them", async () => {
	const { h, turn } = await turnOf(failing("chat_output_empty"));
	expect(turn.error).toBeNull();
	expect(turn.status).toBe("ready");
	expect(h.dialogue.answerText(turn.runId!)).toBe(FAILED);
	expect(h.dialogue.get(turn.runId!)?.status).toBe("completed");
});

test("a talk that fails before a word gets the host's words, and the voice turn speaks them", async () => {
	const { h, turn } = await turnOf(failing("chat_stream_too_large"));
	expect(turn.error).toBeNull();
	expect(turn.status).toBe("ready");
	expect(h.dialogue.answerText(turn.runId!)).toBe(FAILED);
});
