import { useCallback, useEffect, useRef, useState } from "react";
import type { VoiceDialogueClient } from "../../../../../client/voice-dialogue";
import {
	createScreenOutput,
	type AudioController,
	type OutputController,
	type ScreenOutput,
} from "../../audio";
import type { AvatarCue } from "../../avatar";
import { describeError } from "../../../errorMessages";

import {
	createRunSpeechSource,
	type RunSpeechSource,
} from "./run-speech-source";
import { playClause } from "./play-clause";

type Run = { abort: AbortController; automatic: boolean };
export type ReplayAudioSettings = {
	outputVolume?: number;
	outputDevice?: string;
};
export type ReplayDeps = {
	/** The live voice session's controller, when one is running (shares gate and epoch). */
	sessionAudio?: () => Pick<AudioController, "play" | "stopPlayback"> | null;
	/** Cuts off the live reply before a replay starts. */
	interruptLive?: () => void;
	/** The screen's output shared with notices (spec tts-single-lane §4.4). */
	output?: ScreenOutput;
	/** Makes the controller of the hook's own output when no screen output is shared. */
	createOutput?: (outputDevice: string) => OutputController;
};

/**
 * Reads a finished answer aloud again, clause by clause, outside any voice turn. A reading holds the
 * screen output's speech lane, so a notice waits for it; each clause waits for a sounding notice.
 */
export function useReplay(
	client: VoiceDialogueClient,
	settings: ReplayAudioSettings = {},
	deps: ReplayDeps = {},
) {
	const [playingId, setPlayingId] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [subtitle, setSubtitle] = useState<string | null>(null);
	const [avatarCue, setAvatarCue] = useState<AvatarCue | null>(null);
	const run = useRef<Run | null>(null);
	const [ownOutput] = useState(() => createScreenOutput(deps.createOutput));
	/** The output a clause of this hook is sounding on; stopping cuts only that. */
	const sounding = useRef<Pick<AudioController, "stopPlayback"> | null>(null);
	const latest = useRef({ settings, deps });
	useEffect(() => {
		latest.current = { settings, deps };
	});
	const stop = useCallback(() => {
		const current = run.current;
		run.current = null;
		if (current) current.abort.abort();
		const cut = sounding.current;
		sounding.current = null;
		cut?.stopPlayback();
		setPlayingId(null);
		setSubtitle(null);
		setAvatarCue(null);
	}, []);
	const stopAutomatic = useCallback(() => {
		if (run.current?.automatic) stop();
	}, [stop]);
	useEffect(
		() => () => {
			stop();
			ownOutput.release();
		},
		[stop, ownOutput],
	);
	// Unlock output from a user gesture before the asynchronous answer arrives.
	const prepare = useCallback(async () => {
		const { settings: audio, deps: live } = latest.current;
		const session = live.sessionAudio?.();
		if (session) return session;
		const output = latest.current.deps.output ?? ownOutput;
		const owned = output.controller(audio.outputDevice ?? "");
		await output.start(owned);
		return owned.audio;
	}, [ownOutput]);
	const play = useCallback(
		async (
			id: string,
			text: string,
			runId?: string | null,
			options: { automatic?: boolean } = {},
		) => {
			stop();
			setError(null);
			const mine: Run = {
				abort: new AbortController(),
				automatic: options.automatic ?? false,
			};
			run.current = mine;
			setPlayingId(id);
			const { signal } = mine.abort;
			const valid = () => !signal.aborted && run.current === mine;
			const playbackKey = crypto.randomUUID();
			let releaseSpeech = () => {};
			try {
				const { deps: live } = latest.current;
				// A new playback interrupts the live reply, like barge-in does.
				if (!options.automatic) live.interruptLive?.();
				const target = await prepare();
				if (!valid()) return;
				const output = latest.current.deps.output ?? ownOutput;
				releaseSpeech = output.beginSpeech();
				const sentences = await client.replaySentences(text);
				if (!valid()) return;
				const fetchAt = (i: number) =>
					sentences[i] === undefined
						? undefined
						: client.replaySpeech(
								sentences[i],
								signal,
								runId ?? undefined,
								runId ? undefined : id,
							);
				let next = fetchAt(0);
				next?.catch(() => {});
				// A clause whose speech failed is not spoken; the reading goes on (spec tts-single-lane §4.6).
				let spoken = false;
				let failure: unknown;
				for (let i = 0; i < sentences.length; i++) {
					let speech:
						Awaited<ReturnType<typeof client.replaySpeech>> | undefined;
					try {
						speech = await next;
					} catch (e) {
						failure ??= e;
					}
					if (!valid()) return;
					next = fetchAt(i + 1);
					next?.catch(() => {});
					if (!speech) continue;
					const key = `replay:${playbackKey}:${i}`;
					const volume = Math.min(
						1,
						Math.max(0, latest.current.settings.outputVolume ?? 1),
					);
					let cut = false;
					// A notice that is sounding finishes before the clause (spec tts-single-lane §4.4).
					await output.noticeQuiet(signal);
					const played = await playClause(
						target,
						speech.wav,
						signal,
						{
							assistantSpeech: true,
							timing: { runId: runId ?? undefined, chunkIndex: i },
							volume,
							shouldPlay: valid,
							onStarted: () => {
								if (!valid()) return;
								spoken = true;
								sounding.current = target;
								setSubtitle(sentences[i] ?? null);
								if (volume > 0 || speech.emotion)
									setAvatarCue({
										key,
										motion: speech.motion,
										...(speech.emotion ? { emotion: speech.emotion } : {}),
										gestureKey: mine.automatic ? `message:${id}` : playbackKey,
										speaking: volume > 0,
									});
								else setAvatarCue(null);
							},
						},
						() => {
							if (sounding.current === target) sounding.current = null;
							if (valid()) {
								setSubtitle(null);
								setAvatarCue((cue) =>
									cue?.key === key ? { ...cue, speaking: false } : cue,
								);
							}
						},
						() => sounding.current === target,
					);
					cut = played.interrupted;
					// Interrupted by something else: stop reading the rest.
					if (!valid() || cut) return;
				}
				// Only a reading the user asked for says that nothing could be spoken.
				if (!spoken && failure !== undefined && !options.automatic)
					setError(describeError(failure));
			} catch (e) {
				if (!signal.aborted) setError(describeError(e));
			} finally {
				releaseSpeech();
				// A microphone interruption may leave the next clause's synthesis in flight.
				mine.abort.abort();
				if (run.current === mine) {
					run.current = null;
					setPlayingId(null);
					setSubtitle(null);
					setAvatarCue(null);
				}
			}
		},
		[client, stop, prepare, ownOutput],
	);
	const prepareStream = useCallback(
		(runId: string, screenId: string) =>
			createRunSpeechSource(client, runId, screenId),
		[client],
	);
	const playStream = useCallback(
		async (source: RunSpeechSource) => {
			stop();
			setError(null);
			const mine: Run = { abort: new AbortController(), automatic: true };
			run.current = mine;
			setPlayingId(`run:${source.runId}`);
			const valid = () => run.current === mine && !mine.abort.signal.aborted;
			mine.abort.signal.addEventListener("abort", source.stop, { once: true });
			let release = () => {};
			try {
				const target = await prepare();
				if (!valid()) return;
				const output = latest.current.deps.output ?? ownOutput;
				release = output.beginSpeech();
				for (;;) {
					const chunk = await source.next();
					if (!chunk || !valid()) return;
					if (chunk.signal.aborted) continue;
					const signal = AbortSignal.any([mine.abort.signal, chunk.signal]);
					const current = () => valid() && !signal.aborted;
					await output.noticeQuiet(mine.abort.signal);
					if (!current()) continue;
					const volume = Math.min(
						1,
						Math.max(0, latest.current.settings.outputVolume ?? 1),
					);
					const key = `stream:${source.runId}:${chunk.index}`;
					const played = await playClause(
						target,
						chunk.wav,
						signal,
						{
							assistantSpeech: true,
							volume,
							shouldPlay: current,
							timing: { runId: source.runId, chunkIndex: chunk.index },
							onStarted: () => {
								if (!current()) return;
								sounding.current = target;
								setSubtitle(chunk.text);
								if (volume > 0 || chunk.emotion)
									setAvatarCue({
										key,
										motion: chunk.motion,
										...(chunk.emotion ? { emotion: chunk.emotion } : {}),
										gestureKey: `run:${source.runId}`,
										speaking: volume > 0,
									});
							},
						},
						() => {
							if (sounding.current === target) sounding.current = null;
							if (valid()) {
								setSubtitle(null);
								setAvatarCue((cue) => (cue?.key === key ? null : cue));
							}
						},
						() => sounding.current === target,
					);
					if (!valid()) return;
					if (chunk.signal.aborted) continue;
					if (played.interrupted || !played.started) return;
					// A receipt frees a server slot; its network round trip must not delay ready audio.
					void chunk.played(volume > 0).catch((error) => {
						if (!chunk.signal.aborted && valid()) {
							setError(describeError(error));
							source.stop();
						}
					});
				}
			} catch (error) {
				if (valid()) setError(describeError(error));
			} finally {
				release();
				source.stop();
				mine.abort.signal.removeEventListener("abort", source.stop);
				if (run.current === mine) {
					run.current = null;
					setPlayingId(null);
					setSubtitle(null);
					setAvatarCue(null);
				}
			}
		},
		[stop, prepare, ownOutput],
	);

	return {
		playingId,
		error,
		subtitle,
		avatarCue,
		play,
		prepareStream,
		playStream,
		stop,
		stopAutomatic,
		prepare,
	};
}
