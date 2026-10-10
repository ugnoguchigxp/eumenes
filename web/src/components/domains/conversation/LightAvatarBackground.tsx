import { useEffect, useRef, useState } from "react";
import type { LightAvatar } from "./light-avatar/model.js";
import { createAvatarPlayback, type AvatarCue } from "../../../domains/avatar";

type ModelModule = typeof import("./light-avatar/model.js");
let modulePromise: Promise<ModelModule> | null = null;
const loadModule = () => {
	modulePromise ??= import("./light-avatar/model.js").catch(
		(error: unknown) => {
			modulePromise = null;
			throw error;
		},
	);
	return modulePromise;
};
function scheduleIdle(callback: () => void): () => void {
	if (typeof window.requestIdleCallback === "function") {
		const id = window.requestIdleCallback(callback, { timeout: 300 });
		return () => window.cancelIdleCallback(id);
	}
	const id = window.setTimeout(callback, 1500);
	return () => window.clearTimeout(id);
}

export function LightAvatarBackground({
	active,
	cue = null,
	phase = "neutral",
}: {
	active: boolean;
	cue?: AvatarCue | null;
	phase?: "neutral" | "listening" | "thinking";
}) {
	const host = useRef<HTMLDivElement>(null);
	const playback = useRef<ReturnType<typeof createAvatarPlayback> | null>(null);
	const [reduced, setReduced] = useState(
		() => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
	);
	const latest = useRef<AvatarCue | null>(null);
	const [visible, setVisible] = useState(
		() => document.visibilityState !== "hidden",
	);
	useEffect(() => {
		const changed = () => setVisible(document.visibilityState !== "hidden");
		const media = window.matchMedia("(prefers-reduced-motion: reduce)");
		const reducedChanged = () => setReduced(media.matches);
		document.addEventListener("visibilitychange", changed);
		media.addEventListener("change", reducedChanged);
		return () => {
			document.removeEventListener("visibilitychange", changed);
			media.removeEventListener("change", reducedChanged);
		};
	}, []);
	const reducedRef = useRef(reduced);
	const visibleRef = useRef(visible);
	// Set by the lifecycle effect so the pause effect can rebuild only the playback.
	const resync = useRef<(() => void) | null>(null);
	useEffect(() => {
		const element = host.current;
		if (!element) return;
		element.dataset.avatarState = !active ? "inactive" : "loading";
		if (!active) return;
		if (!window.WebGL2RenderingContext) {
			element.dataset.avatarState = "unsupported";
			return;
		}
		let cancelled = false;
		let model: LightAvatar | undefined;
		let observer: ResizeObserver | undefined;
		let failed = false;
		let restarts = 0;
		let restartTimer: ReturnType<typeof setTimeout> | undefined;
		const disposePlayback = () => {
			playback.current?.dispose();
			playback.current = null;
		};
		const release = () => {
			resync.current = null;
			observer?.disconnect();
			disposePlayback();
			model?.canvas.removeEventListener("webglcontextlost", contextLost);
			model?.dispose();
			model = undefined;
		};
		const contextLost = (event: Event) => {
			event.preventDefault();
			element.dataset.avatarState = "context-lost";
			failed = true;
			release();
			// A lost context never restores on a released canvas: rebuild, bounded.
			if (restarts < 3) {
				restartTimer = setTimeout(
					() => {
						if (cancelled) return;
						restarts += 1;
						failed = false;
						element.dataset.avatarState = "loading";
						start();
					},
					2000 * 2 ** restarts,
				);
			}
		};
		// Pause/reduced changes only rebuild the cheap playback; the model and shaders stay.
		const sync = () => {
			if (!model || cancelled) return;
			disposePlayback();
			if (!visibleRef.current) {
				element.dataset.avatarState = "paused";
				return;
			}
			const controller = createAvatarPlayback(model, {
				reduced: reducedRef.current,
				onError: () => {
					element.dataset.avatarState = "render-failed";
					failed = true;
					release();
				},
			});
			if (failed || !model) {
				controller.dispose();
				return;
			}
			playback.current = controller;
			element.dataset.avatarState = "ready";
			controller.setCue(latest.current);
		};
		const start = () => {
			void loadModule()
				.then(({ createLightAvatar }) => {
					if (cancelled) return;
					model = createLightAvatar(element);
					if (!model) return;
					model.canvas.addEventListener("webglcontextlost", contextLost);
					resync.current = sync;
					sync();
					if (failed || !model) return;
					observer = new ResizeObserver(() => {
						if (!model || !element.clientWidth || !element.clientHeight) return;
						try {
							model.resize();
							playback.current?.redraw();
						} catch {
							element.dataset.avatarState = "resize-failed";
							release();
						}
					});
					observer.observe(element);
				})
				.catch((error: unknown) => {
					if (cancelled) return;
					element.dataset.avatarState = "load-failed";
					console.warn("Light avatar initialization failed", {
						kind: error instanceof Error ? error.name : "unknown",
					});
					release();
				});
		};
		// The three.js chunk is large: first load waits until the main thread is idle.
		const cancelIdle = modulePromise
			? (start(), () => {})
			: scheduleIdle(start);
		return () => {
			cancelled = true;
			clearTimeout(restartTimer);
			cancelIdle();
			release();
		};
	}, [active]);
	useEffect(() => {
		reducedRef.current = reduced;
		visibleRef.current = visible;
		resync.current?.();
	}, [visible, reduced]);
	useEffect(() => {
		latest.current =
			cue ??
			(phase === "neutral" ? null : { key: `phase:${phase}`, motion: phase });
		playback.current?.setCue(latest.current);
	}, [cue, phase]);
	return (
		<div
			ref={host}
			className="light-avatar-background"
			data-avatar-motion={reduced ? "static" : "animated"}
			aria-hidden="true"
		/>
	);
}
