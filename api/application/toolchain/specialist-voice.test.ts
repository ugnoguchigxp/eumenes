import { afterEach, expect, test } from "bun:test";
import type { LarmPort } from "../../domains/larm";
import {
	analysisReceipt,
	isAnalysisRound,
} from "../../domains/dialogue/test/analysis.fixture";
import { waitFor } from "../../infrastructure/wait-for";
import { harness } from "./toolchain.fixture";

/**
 * Spoken requests to the UI studio's specialist: the first switches the conversation to the specialist
 * in the same run, a later one is addressed to it directly. Each reply must be spoken; the run's answer
 * request is accepted as the host's (the specialist, not the conversation's model, answered), else the
 * voice turn ended `permission_revoked`. Nothing but the models is faked.
 */
const requests = {
	create: "来場者アンケートのUIを作ってください",
	soften: "もっとやわらかい雰囲気にしてください",
};
const replies = {
	[requests.create]: "アンケートの初稿を作りました。",
	[requests.soften]: "雰囲気をやわらかくしました。",
} as Record<string, string>;
const definition = (title: string) => ({
	view: "layout",
	direction: "stack",
	children: [{ view: "text-block", title }],
});
const wav = () => {
	const bytes = new Uint8Array(48);
	bytes.set(new TextEncoder().encode("RIFF"));
	bytes.set(new TextEncoder().encode("WAVE"), 8);
	return bytes;
};

/** The utterance the next voice turn transcribes to. */
let spoken = requests.create;
function model(): LarmPort {
	return {
		status: () => ({ state: "ready", capabilities: ["llm", "asr", "tts"] }),
		connect: async () => {},
		close: async () => {},
		transcribe: async () => spoken,
		speak: async () => wav(),
		answer: async (messages, _signal, options) => {
			const system = messages[0]!.content;
			if (system.includes("転記された発話の主要な言語"))
				return JSON.stringify({
					status: "identified",
					languages: ["ja"],
					confidence: 0.99,
				});
			// The specialist writes the work document with the reply it speaks once that succeeds: one call.
			if (system.includes("TOOLS=")) {
				const revision = Number(
					/CURRENT_DOCUMENT path=definition\.json revision=(\d+)/.exec(
						messages.map((m) => m.content).join("\n"),
					)?.[1] ?? 0,
				);
				return JSON.stringify({
					action: "invoke",
					tool: "doc.write",
					arguments: {
						baseRevision: revision,
						title: spoken,
						content: definition(spoken),
					},
					text: replies[spoken],
				});
			}
			// The conversation's first round delegates to the studio; the second writes its request.
			if (isAnalysisRound(options?.tools)) {
				options!.onToolCalls!(
					analysisReceipt("fixture", {
						name: "ui_create",
						args: { kind: "creation" },
						announcement: "制作担当に引き継ぎます。",
					}).toolCalls as never,
				);
				return "";
			}
			if (options?.tools?.length) {
				options.onToolCalls!([
					{
						id: crypto.randomUUID(),
						name: "ui_create",
						arguments: JSON.stringify({ request: spoken }),
					},
				]);
				return "";
			}
			return "かしこまりました。";
		},
	};
}

const rigs: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => {
	for (const rig of rigs.splice(0)) await rig.close();
});

/** Speaks `text`, plays every chunk as it arrives, and returns the voice turn and its run once both end. */
async function speak(
	h: Awaited<ReturnType<typeof harness>>,
	sessionId: string,
	sequence: number,
	text: string,
) {
	spoken = text;
	const id = crypto.randomUUID();
	await h.voice.accept(sessionId, 1, sequence, id, wav());
	await waitFor(() => h.voice.get(id)?.status === "input_ready");
	await h.voice.commit(id, h.voice.get(id)!.revision);
	const played = new Set<number>();
	for (let tick = 0; tick < 100; tick++) {
		const turn = h.voice.get(id)!;
		for (const chunk of turn.audioChunks ?? [])
			if (!played.has(chunk.index)) {
				played.add(chunk.index);
				await h.voice.played(id, chunk.index).catch(() => {});
			}
		const run = turn.runId ? h.dialogue.get(turn.runId) : null;
		if (
			["failed", "ready", "played", "completed"].includes(turn.status) &&
			run &&
			!["queued", "running"].includes(run.status)
		)
			break;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	const turn = h.voice.get(id)!;
	return { turn, run: h.dialogue.get(turn.runId!)! };
}

test("a spoken request switches to the specialist; its reply is spoken, and so is the reply to the next spoken request", async () => {
	const h = await harness({ uiCompositions: true, model: model() });
	rigs.push(h);
	const sessionId = crypto.randomUUID();
	h.voice.start(sessionId, 1);

	const first = await speak(h, sessionId, 1, requests.create);
	expect(first.run.status).toBe("completed");
	expect({
		status: first.turn.status,
		error: first.turn.error ?? null,
	}).not.toMatchObject({
		status: "failed",
	});
	expect(first.turn.error ?? null).toBeNull();
	expect(first.turn.status).not.toBe("failed");
	expect(h.dialogue.answerText(first.run.id)).toBe(replies[requests.create]!);

	// The specialist is now the addressee: the next request never reaches the conversation's model.
	const second = await speak(h, sessionId, 2, requests.soften);
	expect(second.run.status).toBe("completed");
	expect(second.turn.error ?? null).toBeNull();
	expect(second.turn.status).not.toBe("failed");
	expect(h.dialogue.answerText(second.run.id)).toBe(replies[requests.soften]!);
}, 20000);
