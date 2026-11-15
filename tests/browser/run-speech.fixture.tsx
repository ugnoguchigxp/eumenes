import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { voiceDialogueClient } from "../../client/voice-dialogue";
import {
	createAudioController,
	type OutputController,
} from "../../web/src/domains/audio";
import { useReplay } from "../../web/src/domains/voice-dialogue/hooks/replay";
import { useAutomaticSpeech } from "../../web/src/domains/voice-dialogue/hooks/automatic";
import type { Run } from "../../api/domains/dialogue/contracts";
import type { RunSpeechEvent } from "../../api/domains/voice-dialogue/contracts";
const id = { runId: "fixture-run", sessionId: crypto.randomUUID() };
let generationId = crypto.randomUUID();
let sink: ReadableStreamDefaultController<Uint8Array> | undefined;
let closed = false;
const events: Array<{ type: string; index?: number; at: number }> = [];
const note = (type: string, index?: number) =>
	events.push({ type, index, at: performance.now() });
function send(event: RunSpeechEvent) {
	if (!closed)
		sink?.enqueue(
			new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`),
		);
}
const client = voiceDialogueClient({
	identity: "fixture",
	call: async (path, init) => {
		if (path.endsWith("/played")) {
			const { index } = JSON.parse(String(init?.body));
			note("ack", index);
			return Response.json({ ok: true });
		}
		if (!path.endsWith("/speech")) throw new Error("unexpected_request");
		return new Response(
			new ReadableStream({
				start(controller) {
					sink = controller;
					note("connected");
					init?.signal?.addEventListener("abort", () => {
						if (!closed) {
							closed = true;
							controller.close();
							note("closed");
						}
					});
					send({ ...id, type: "start" });
					send({ ...id, type: "generation", generationId });
				},
				cancel() {
					closed = true;
					note("closed");
				},
			}),
			{ headers: { "Content-Type": "text/event-stream" } },
		);
	},
});
function silentWav() {
	const bytes = new Uint8Array(44 + 16_000); // 500 ms of silent PCM, never audible even without the browser flag.
	const view = new DataView(bytes.buffer);
	const tag = (i: number, value: string) =>
		bytes.set(new TextEncoder().encode(value), i);
	tag(0, "RIFF");
	view.setUint32(4, bytes.length - 8, true);
	tag(8, "WAVE");
	tag(12, "fmt ");
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, 1, true);
	view.setUint32(24, 16000, true);
	view.setUint32(28, 32000, true);
	view.setUint16(32, 2, true);
	view.setUint16(34, 16, true);
	tag(36, "data");
	view.setUint32(40, bytes.length - 44, true);
	return btoa(String.fromCharCode(...bytes));
}
function createOutput(device: string): OutputController {
	const audio = createAudioController(
		() => {},
		() => {},
		() => {},
		{ outputDevice: device, keepAlive: false },
	);
	return {
		...audio,
		play: (wav, ended, options = {}) =>
			audio.play(
				wav,
				() => {
					note("ended", options.timing?.chunkIndex);
					ended();
				},
				{
					...options,
					onStarted: () => {
						note("started", options.timing?.chunkIndex);
						options.onStarted?.();
					},
					onInterrupted: () => {
						note("interrupted", options.timing?.chunkIndex);
						options.onInterrupted?.();
					},
				},
			),
	};
}
const base = {
	id: id.runId,
	status: "running",
	utteranceId: null,
	answerMessageId: null,
} as Run;
const screenId = crypto.randomUUID();
function Fixture() {
	const [runs, setRuns] = useState<Run[]>([]);
	const [enabled, setEnabled] = useState(true);
	const player = useReplay(client, {}, { createOutput });

	useAutomaticSpeech({
		runs,
		messages: [],
		enabled,
		player,
		ownsSpeech: () => false,
		screen: {
			screenId,
			playbackScreen: true,
			claim: async () => true,
		},
		speaker: null,
	});
	useEffect(() => {
		window.runSpeechFixture = {
			events: () => events,
			audio(index) {
				note("received", index);
				send({
					...id,
					type: "audio",
					generationId,
					index,
					text: `句${index}。`,
					wav: silentWav(),
				});
			},
			replace() {
				generationId = crypto.randomUUID();
				send({ ...id, type: "generation", generationId });
			},
			fail() {
				send({ ...id, type: "error", reason: "tts_failed" });
			},
			mute() {
				setEnabled(false);
			},
			finish() {
				setRuns([{ ...base, status: "completed", answerMessageId: "answer" }]);
				send({ ...id, type: "finished" });
			},
		};
	}, []);
	return (
		<main>
			<button
				onClick={() => {
					void player.prepare();
					setRuns([base]);
				}}
			>
				開始
			</button>
			<p data-testid="status">{runs[0]?.status ?? "idle"}</p>
			<p data-testid="subtitle">{player.subtitle ?? ""}</p>
			<p data-testid="playing">{player.playingId ?? ""}</p>
		</main>
	);
}
declare global {
	interface Window {
		runSpeechFixture: {
			events(): typeof events;
			audio(index: number): void;
			replace(): void;
			fail(): void;
			mute(): void;
			finish(): void;
		};
	}
}
createRoot(document.getElementById("root")!).render(<Fixture />);
