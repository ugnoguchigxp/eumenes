import { useEffect, useRef, useState } from "react";
import { useAudioAnalysis } from "./useAudioAnalysis";

export function usePlayback(autoPlay: boolean, analyse = false) {
	const ref = useRef<HTMLAudioElement>(null);
	const analysis = useAudioAnalysis(ref, analyse);
	const [playing, setPlaying] = useState(false);
	const [position, setPosition] = useState(0);
	const [duration, setDuration] = useState(0);
	const [volume, setVolume] = useState(1);
	const [error, setError] = useState(false);
	useEffect(() => {
		const audio = ref.current;
		let active = true;
		if (autoPlay) void audio?.play().catch(() => active && setError(true));
		return () => {
			active = false;
			audio?.pause();
		};
	}, [autoPlay]);
	const seek = (seconds: number) => {
		if (!ref.current || !duration) return;
		const next = Math.max(0, Math.min(duration, seconds));
		ref.current.currentTime = next;
		setPosition(next);
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
		setVolume: (value: number) => {
			if (ref.current) ref.current.volume = value;
			setVolume(value);
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
			onVolumeChange: () => setVolume(ref.current?.volume ?? 1),
		},
	};
}
