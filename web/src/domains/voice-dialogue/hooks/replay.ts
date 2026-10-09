import { useCallback, useEffect, useRef, useState } from "react";
import type { VoiceDialogueClient } from "../../../../../client/voice-dialogue";
import {
	createAudioController,
	type AudioController,
	type OutputController,
} from "../../audio";
import type { AvatarCue } from "../../avatar";

type Run = { abort: AbortController };
export type ReplayAudioSettings = {
	outputVolume?: number;
	outputDevice?: string;
};
export type ReplayDeps = {
	/** The live voice session's controller, when one is running (shares gate and epoch). */
	sessionAudio?: () => Pick<AudioController, "play" | "stopPlayback"> | null;
	/** Cuts off the live reply before a replay starts. */
	interruptLive?: () => void;
	createOutput?: (outputDevice: string) => OutputController;
};

const defaultOutput = (outputDevice: string): OutputController =>
	createAudioController(
		() => {},
		() => {},
		() => {},
		{ outputDevice, keepAlive: false },
	);

/** Reads a finished answer aloud again, clause by clause, outside any voice turn. */
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
	const output = useRef<{ device: string; audio: OutputController } | null>(
		null,
	);
	const latest = useRef({ settings, deps });
	useEffect(() => {
		latest.current = { settings, deps };
	});
	const releaseOutput = useCallback(() => {
		const owned = output.current;
		output.current = null;
		void owned?.audio.stop();
	}, []);
	const stop = useCallback(() => {
		const current = run.current;
		run.current = null;
		if (current) current.abort.abort();
		if (current) {
			output.current?.audio.stopPlayback();
			latest.current.deps.sessionAudio?.()?.stopPlayback();
		}
		setPlayingId(null);
		setSubtitle(null);
		setAvatarCue(null);
	}, []);
	useEffect(
		() => () => {
			stop();
			releaseOutput();
		},
		[stop, releaseOutput],
	);
	const play = useCallback(
		async (id: string, text: string, runId?: string | null) => {
			stop();
			setError(null);
			const mine: Run = { abort: new AbortController() };
			run.current = mine;
			setPlayingId(id);
			const { signal } = mine.abort;
			const valid = () => !signal.aborted && run.current === mine;
			const playbackKey = crypto.randomUUID();
			try {
				const { deps: live, settings: audio } = latest.current;
				// A new playback interrupts the live reply, like barge-in does.
				live.interruptLive?.();
				const session = live.sessionAudio?.() ?? null;
				let target: Pick<AudioController, "play" | "stopPlayback">;
				if (session) target = session;
				else {
					const device = audio.outputDevice ?? "";
					if (output.current?.device !== device) {
						releaseOutput();
						const created = (live.createOutput ?? defaultOutput)(device);
						output.current = { device, audio: created };
						await created.startOutput();
					}
					const owned = output.current;
					if (!valid() || !owned) return;
					target = owned.audio;
				}
				const sentences = await client.replaySentences(text);
				const fetchAt = (i: number) =>
					sentences[i] === undefined
						? undefined
						: client.replaySpeech(sentences[i], signal, runId ?? undefined);
				let next = fetchAt(0);
				for (let i = 0; i < sentences.length; i++) {
					const speech = await next;
					if (!valid() || !speech) return;
					next = fetchAt(i + 1);
					next?.catch(() => {});
					const key = `replay:${playbackKey}:${i}`;
					const volume = Math.min(
						1,
						Math.max(0, latest.current.settings.outputVolume ?? 1),
					);
					let cut = false;
					await new Promise<void>((resolve, reject) => {
						let started = false;
						const finish = () => {
							signal.removeEventListener("abort", finish);
							if (started && valid()) {
								setSubtitle(null);
								setAvatarCue((cue) => (cue?.key === key ? null : cue));
							}
							resolve();
						};
						signal.addEventListener("abort", finish, { once: true });
						target
							.play(speech.wav, finish, {
								volume,
								shouldPlay: valid,
								onInterrupted: () => {
									cut = true;
									finish();
								},
								onStarted: () => {
									if (!valid()) return;
									started = true;
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
			} catch (e) {
				if (!signal.aborted)
					setError(
						`読み上げ直しに失敗しました（${e instanceof Error ? e.message : "不明なエラー"}）`,
					);
			} finally {
				if (run.current === mine) {
					run.current = null;
					setPlayingId(null);
					setSubtitle(null);
					setAvatarCue(null);
				}
			}
		},
		[client, stop, releaseOutput],
	);
	return { playingId, error, subtitle, avatarCue, play, stop };
}
