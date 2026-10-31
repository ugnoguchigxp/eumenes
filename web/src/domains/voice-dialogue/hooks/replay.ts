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
						| Awaited<ReturnType<typeof client.replaySpeech>>
						| undefined;
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
					await new Promise<void>((resolve, reject) => {
						let started = false;
						const finish = () => {
							signal.removeEventListener("abort", finish);
							if (sounding.current === target) sounding.current = null;
							if (started && valid()) {
								setSubtitle(null);
								setAvatarCue((cue) => (cue?.key === key ? null : cue));
							}
							resolve();
						};
						signal.addEventListener("abort", finish, { once: true });
						target
							.play(speech.wav, finish, {
								timing: { runId: runId ?? undefined, chunkIndex: i },
								volume,
								shouldPlay: valid,
								onInterrupted: () => {
									cut = true;
									finish();
								},
								onStarted: () => {
									if (!valid()) return;
									started = true;
									spoken = true;
									sounding.current = target;
									setSubtitle(sentences[i] ?? null);
									if (volume > 0)
										setAvatarCue({
											key,
											motion: speech.motion,
											speaking: true,
										});
								},
							})
							.then(() => {
								// Discarded before it began (superseded): nothing will end it.
								if (!started) finish();
							}, reject);
					});
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
	return {
		playingId,
		error,
		subtitle,
		avatarCue,
		play,
		stop,
		stopAutomatic,
		prepare,
	};
}
