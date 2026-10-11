import { useEffect, useRef, useState, type RefObject } from "react";

/** One graph per player, created from a user playback gesture; analysis failure never stops audio. */
export function useAudioAnalysis(
	audio: RefObject<HTMLAudioElement | null>,
	enabled: boolean,
) {
	const graph = useRef<{
		context: AudioContext;
		source: MediaElementAudioSourceNode;
		analyser: AnalyserNode;
	} | null>(null);
	const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);
	const [error, setError] = useState(false);
	const attached = useRef(false);
	const activating = useRef<Promise<void> | null>(null);
	useEffect(() => {
		attached.current = true;
		return () => {
			attached.current = false;
			// StrictMode's immediate effect replay retains the same media element.
			queueMicrotask(() => {
				if (attached.current || !graph.current) return;
				const { context, source, analyser: node } = graph.current;
				source.disconnect();
				node.disconnect();
				void context.close().catch(() => {});
				graph.current = null;
			});
		};
	}, []);
	async function start() {
		if (!enabled || !audio.current) return;
		try {
			if (!graph.current) {
				if (typeof AudioContext === "undefined") throw new Error("unavailable");
				const context = new AudioContext();
				let source: MediaElementAudioSourceNode;
				let node: AnalyserNode;
				try {
					if (context.state === "suspended") await context.resume();
					if (!attached.current) {
						void context.close().catch(() => {});
						return;
					}
					node = context.createAnalyser();
					source = context.createMediaElementSource(audio.current);
				} catch (failure) {
					void context.close().catch(() => {});
					throw failure;
				}
				node.fftSize = 256;
				source.connect(node);
				node.connect(context.destination);
				graph.current = { context, source, analyser: node };
				setAnalyser(node);
			}
			if (graph.current.context.state === "suspended")
				await graph.current.context.resume();
			if (attached.current) setError(false);
		} catch {
			if (attached.current) setError(true);
		}
	}
	async function activate() {
		if (activating.current) return activating.current;
		const operation = start();
		activating.current = operation;
		try {
			await operation;
		} finally {
			activating.current = null;
		}
	}
	return { analyser, error, activate };
}
