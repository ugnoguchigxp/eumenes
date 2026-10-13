import { useCallback, useEffect, useRef, useState } from "react";
import type { EumenesClient } from "../../../../client";

type Run = { abort: AbortController; audio?: HTMLAudioElement; url?: string };
/** Shared by legacy and artifact forms. The active generation owns audio and URL. */
export function useVoiceSample(
	client: EumenesClient,
	voice: Parameters<EumenesClient["voiceSample"]>[0],
	disabled = false,
	volume = 1,
	outputDevice = "",
) {
	const target = JSON.stringify([
		client.identity,
		voice,
		disabled,
		outputDevice,
	]);
	const [snapshot, setSnapshot] = useState<{
		target: string;
		state: "idle" | "loading" | "playing";
		error: string;
	}>({ target, state: "idle", error: "" });
	const state = snapshot.target === target ? snapshot.state : "idle";
	const error = snapshot.target === target ? snapshot.error : "";
	const setState = (state: "idle" | "loading" | "playing") =>
		setSnapshot({ target, state, error: "" });
	const setError = (error: string) =>
		setSnapshot({ target, state: "idle", error });
	const run = useRef<Run | null>(null);
	const release = useCallback(() => {
		const current = run.current;
		run.current = null;
		current?.abort.abort();
		if (current?.audio) {
			current.audio.onended = null;
			current.audio.onerror = null;
			current.audio.pause();
			current.audio.removeAttribute("src");
		}
		if (current?.url) URL.revokeObjectURL(current.url);
	}, []);
	function stop() {
		release();
		setState("idle");
	}
	// Cleanup synchronizes the external request/audio lifecycle; UI state is keyed by target.
	useEffect(() => release, [target, release]);
	useEffect(() => {
		if (run.current?.audio) run.current.audio.volume = volume;
	}, [volume]);
	async function play() {
		if (disabled) return;
		stop();
		setError("");
		const mine: Run = { abort: new AbortController() };
		run.current = mine;
		setState("loading");
		try {
			const bytes = await client.voiceSample(voice, mine.abort.signal);
			if (run.current !== mine) return;
			mine.url = URL.createObjectURL(
				new Blob([new Uint8Array(bytes)], { type: "audio/wav" }),
			);
			const audio = new Audio(mine.url);
			mine.audio = audio;
			audio.volume = volume;
			audio.onended = () => {
				if (run.current === mine) stop();
			};
			audio.onerror = () => {
				if (run.current === mine) {
					stop();
					setError("サンプルを再生できませんでした。");
				}
			};
			if (outputDevice) {
				if (!("setSinkId" in audio))
					throw new Error("sample_output_unsupported");
				await (
					audio as HTMLAudioElement & {
						setSinkId: (id: string) => Promise<void>;
					}
				).setSinkId(outputDevice);
				if (run.current !== mine) return;
			}
			setState("playing");
			await audio.play();
		} catch {
			if (run.current !== mine) return;
			stop();
			setError(
				"サンプルを作成・再生できませんでした。接続とブラウザの音声許可を確認してください。",
			);
		}
	}
	return { state, error, play, stop };
}
