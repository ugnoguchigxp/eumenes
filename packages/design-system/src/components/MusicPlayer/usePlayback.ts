import { useEffect, useRef, useState } from "react";
import { useAudioAnalysis } from "./useAudioAnalysis";

export function usePlayback(
	autoPlay: boolean,
	volume: number,
	onVolumeChange: (volume: number) => void,
	analyse = false,
) {
	const ref = useRef<HTMLAudioElement>(null);
	const analysis = useAudioAnalysis(ref, analyse);
	const [playing, setPlaying] = useState(false);
	const [position, setPosition] = useState(0);
	const [duration, setDuration] = useState(0);
	const [error, setError] = useState(false);
	// Playback intent applies once per mounted track; later changes come from this player's own events.
	const [initialAutoPlay] = useState(autoPlay);
	const attached = useRef(false);
	// Apply the player's retained volume before a replacement track can start.
	useEffect(() => {
		if (ref.current) ref.current.volume = volume;
	}, [volume]);
	useEffect(() => {
		const audio = ref.current;
		let active = true;
		attached.current = true;
		if (initialAutoPlay)
			void audio?.play().catch(() => active && setError(true));
		return () => {
			active = false;
			attached.current = false;
			if (!audio?.isConnected) {
				audio?.pause();
				return;
			}
			// StrictMode replays setup with the same element. Only a real unmount
			// stops playback requested by the host after the player first mounted.
			queueMicrotask(() => {
				if (!attached.current) audio?.pause();
			});
		};
	}, [initialAutoPlay]);
	const seek = (seconds: number) => {
		if (!ref.current || !duration) return;
		const next = Math.max(0, Math.min(duration, seconds));
		ref.current.currentTime = next;
		setPosition(next);
	};
	/** Starts playback from code; rejects with the media element's error (`NotAllowedError` without a gesture). */
	const start = async () => {
		const audio = ref.current;
		if (!audio) throw new Error("player_unavailable");
		setError(false);
		await audio.play();
	};
	const toggle = async () => {
		const audio = ref.current;
		if (!audio) return;
		setError(false);
		if (!audio.paused) audio.pause();
		else {
			try {
				await analysis.activate();
				await audio.play();
			} catch {
				if (ref.current === audio) setError(true);
			}
		}
	};
	return {
		ref,
		playing,
		position,
		duration,
		volume,
		error,
		analyser: analysis.analyser,
		analysisError: analysis.error,
		seek,
		toggle,
		start,
		setVolume: (value: number) => {
			if (ref.current) ref.current.volume = value;
			onVolumeChange(value);
		},
		events: {
			onPlay: () => {
				setPlaying(true);
				void analysis.activate();
			},
			onPause: () => setPlaying(false),
			onTimeUpdate: () => setPosition(ref.current?.currentTime ?? 0),
			onDurationChange: () => {
				const value = ref.current?.duration ?? 0;
				setDuration(Number.isFinite(value) && value > 0 ? value : 0);
			},
			onError: () => {
				setError(true);
				setPlaying(false);
			},
			onVolumeChange: () => {
				if (ref.current) onVolumeChange(ref.current.volume);
			},
		},
	};
}
