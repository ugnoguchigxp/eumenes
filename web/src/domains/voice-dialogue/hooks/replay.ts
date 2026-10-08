import { useCallback, useEffect, useRef, useState } from "react";
import type { VoiceDialogueClient } from "../../../../../client/voice-dialogue";
import type { AvatarCue } from "../../avatar";

type Run = { abort: AbortController; audio?: HTMLAudioElement };

/** Reads a finished answer aloud again, clause by clause, outside any voice turn. */
export function useReplay(client: VoiceDialogueClient, volume = 1) {
	const [playingId, setPlayingId] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [subtitle, setSubtitle] = useState<string | null>(null);
	const [avatarCue, setAvatarCue] = useState<AvatarCue | null>(null);
	const run = useRef<Run | null>(null);
	const volumeRef = useRef(volume);
	useEffect(() => {
		volumeRef.current = volume;
	}, [volume]);
	const stop = useCallback(() => {
		const current = run.current;
		run.current = null;
		current?.abort.abort();
		current?.audio?.pause();
		setPlayingId(null);
		setSubtitle(null);
		setAvatarCue(null);
	}, []);
	useEffect(() => stop, [stop]);
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
					await new Promise<void>((resolve, reject) => {
						const url = URL.createObjectURL(
							new Blob([new Uint8Array(speech.wav)], { type: "audio/wav" }),
						);
						const audio = new Audio(url);
						audio.volume = Math.min(1, Math.max(0, volumeRef.current));
						mine.audio = audio;
						const key = `replay:${playbackKey}:${i}`;
						const done = () => {
							URL.revokeObjectURL(url);
							signal.removeEventListener("abort", done);
							resolve();
						};
						audio.onended = () => {
							if (valid()) {
								setSubtitle(null);
								setAvatarCue((cue) => (cue?.key === key ? null : cue));
							}
							done();
						};
						audio.onplaying = () => {
							if (valid() && audio.volume > 0)
								setAvatarCue({ key, motion: speech.motion, speaking: true });
						};
						audio.onerror = () => {
							URL.revokeObjectURL(url);
							reject(new Error("audio_playback_failed"));
						};
						signal.addEventListener("abort", done, { once: true });
						audio.play().then(() => {
							if (valid()) setSubtitle(sentences[i] ?? null);
						}, reject);
					});
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
		[client, stop],
	);
	return { playingId, error, subtitle, avatarCue, play, stop };
}
