import type { QueryClient } from "@tanstack/react-query";
import type { VoiceTurn } from "../../../../../api/domains/voice-dialogue/contracts";
import type { VoiceDialogueClient } from "../../../../../client/voice-dialogue";
import type { AudioController } from "../../audio";
import type { AvatarCue } from "../../avatar";
import { queryRoots } from "../../../queryKeys";
import { chunkTiming, timedVoiceAudio } from "./audio-timing";

/** One turn's chunks in playback order; `lastEndedAt` is when the latest one finished. */
export type ChunkQueue = {
	id: string;
	epoch: number;
	tail: Promise<void>;
	lastEndedAt?: number;
};
type Subtitle = { key: string; text: string } | null;
type KeyedCue = AvatarCue | null;

/**
 * Plays a turn's chunks back to back. Each chunk is fetched as soon as it is listed, decoded while
 * the one before still plays (`waitForPrevious`), and reported played without holding up the next.
 * The silence between chunks and how late the audio arrived go with the played report.
 */
export function queueChunks(
	turn: VoiceTurn,
	chunkQueue: ChunkQueue,
	deps: {
		client: VoiceDialogueClient;
		cache: QueryClient;
		controller: () => AudioController | null;
		volume: () => number | undefined;
		delivered: (key: string) => boolean;
		markDelivered: (key: string) => void;
		queued: () => boolean;
		valid: () => boolean;
		setSubtitle: (update: (s: Subtitle) => Subtitle) => void;
		setAvatarCue: (update: (cue: KeyedCue) => KeyedCue) => void;
		fail: (error: unknown) => void;
	},
) {
	const { client, queued, valid } = deps;
	const playable = () => valid() && queued();
	const fail = (error: unknown) => {
		if (playable()) deps.fail(error);
	};
	for (const chunk of turn.audioChunks ?? []) {
		const key = `${turn.utteranceId}:${chunk.index}`;
		if (deps.delivered(key)) continue;
		deps.markDelivered(key);
		const identity = chunkTiming(turn.utteranceId, chunk.index);
		const audio = timedVoiceAudio(client, identity).then((bytes) => ({
			bytes,
			at: performance.now(),
		}));
		// Awaited in turn below; a failure before then must not surface as unhandled.
		audio.catch(() => {});
		chunkQueue.tail = chunkQueue.tail
			.then(async () => {
				if (!playable()) return;
				const { bytes, at } = await audio;
				if (!playable()) return;
				const volume = deps.volume();
				let gap: { gapMs: number; fetchLateMs: number } | undefined;
				const ended = () => {
					chunkQueue.lastEndedAt = performance.now();
					deps.setSubtitle((s) => (s?.key === key ? null : s));
					deps.setAvatarCue((cue) => (cue?.key === key ? null : cue));
					if (!playable()) return;
					void client
						.voicePlayed(
							turn.utteranceId,
							chunk.index,
							(volume ?? 1) > 0 ? gap : { ...gap, audible: false },
						)
						.then(() =>
							deps.cache.invalidateQueries({
								queryKey: [
									queryRoots.voiceDialogue,
									client.identity,
									turn.utteranceId,
								],
							}),
						)
						.catch(fail);
				};
				await deps.controller()?.play(bytes, ended, {
					waitForPrevious: true,
					timing: identity,
					volume,
					shouldPlay: playable,
					onStarted: () => {
						const previous = chunkQueue.lastEndedAt;
						if (previous !== undefined)
							gap = {
								gapMs: Math.round(performance.now() - previous),
								fetchLateMs: Math.max(0, Math.round(at - previous)),
							};
						if (!playable()) return;
						if ((deps.volume() ?? 1) > 0)
							deps.setAvatarCue(() => ({
								key,
								motion: chunk.delivery?.motion ?? "neutral",
								speaking: true,
							}));
					},
				});
				if (playable() && chunk.text.trim())
					deps.setSubtitle(() => ({ key, text: chunk.text.trim() }));
			})
			.catch(fail);
	}
}
