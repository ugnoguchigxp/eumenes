import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { LightAvatar } from "./light-avatar/model.js";
import { createAvatarPlayback, type AvatarCue } from "../../../domains/avatar";
import {
	lightAvatarLoaded,
	loadLightAvatar,
	motionLabOnScreen,
	setBackgroundAvatar,
	subscribeLightAvatar,
} from "./light-avatar/load";

function scheduleIdle(callback: () => void): () => void {
	if (typeof window.requestIdleCallback === "function") {
		const id = window.requestIdleCallback(callback, { timeout: 300 });
		return () => window.cancelIdleCallback(id);
	}
	const id = window.setTimeout(callback, 1500);
	return () => window.clearTimeout(id);
}

type Touch = { id: number; x: number; y: number; hit: boolean };

export function LightAvatarBackground({
	active,
	cue = null,
	phase = "neutral",
	interactive = false,
}: {
	active: boolean;
	cue?: AvatarCue | null;
	phase?: "neutral" | "listening" | "thinking";
	/** Background mode: the chat is hidden, so touching the spirit makes it react. */
	interactive?: boolean;
}) {
	const host = useRef<HTMLDivElement>(null);
	const playback = useRef<ReturnType<typeof createAvatarPlayback> | null>(null);
	const avatar = useRef<LightAvatar | null>(null);
	const [touches, setTouches] = useState<Touch[]>([]);
	const touchId = useRef(0);
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
	// While the settings motion lab is on screen it drives this model instead of the cues.
	const labShown = useSyncExternalStore(
		subscribeLightAvatar,
		motionLabOnScreen,
	);
	const visibleRef = useRef(visible);
	const labRef = useRef(labShown);
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
			avatar.current = null;
			if (model) setBackgroundAvatar(null);
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
			if (labRef.current) {
				element.dataset.avatarState = "motion-lab";
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
			void loadLightAvatar()
				.then(({ createLightAvatar }) => {
					if (cancelled) return;
					model = createLightAvatar(element);
					if (!model) return;
					model.canvas.addEventListener("webglcontextlost", contextLost);
					avatar.current = model;
					resync.current = sync;
					setBackgroundAvatar(model);
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
		const cancelIdle = lightAvatarLoaded()
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
		labRef.current = labShown;
		resync.current?.();
	}, [visible, reduced, labShown]);
	useEffect(() => {
		latest.current =
			cue ??
			(phase === "neutral" ? null : { key: `phase:${phase}`, motion: phase });
		playback.current?.setCue(latest.current);
	}, [cue, phase]);
	useEffect(() => {
		const element = host.current;
		if (!active || !interactive || !element) return;
		let frame = 0;
		let pointer: { x: number; y: number } | null = null;
		const hover = () => {
			frame = 0;
			if (pointer && avatar.current?.hitTest(pointer.x, pointer.y))
				element.dataset.touchable = "true";
			else delete element.dataset.touchable;
		};
		const move = (event: PointerEvent) => {
			if (event.pointerType === "touch") return;
			pointer = { x: event.clientX, y: event.clientY };
			frame ||= requestAnimationFrame(hover);
		};
		const leave = () => {
			pointer = null;
			cancelAnimationFrame(frame);
			frame = 0;
			delete element.dataset.touchable;
		};
		// While the motion lab drives the model there is no playback: only the light ring shows.
		const touch = (event: MouseEvent) => {
			const part =
				avatar.current?.hitTest(event.clientX, event.clientY) ?? null;
			if (part) playback.current?.react(part);
			const rect = element.getBoundingClientRect();
			const next = {
				id: ++touchId.current,
				x: event.clientX - rect.left,
				y: event.clientY - rect.top,
				hit: part !== null,
			};
			setTouches((current) => [...current.slice(-5), next]);
		};
		element.addEventListener("pointermove", move);
		element.addEventListener("pointerleave", leave);
		element.addEventListener("click", touch);
		return () => {
			element.removeEventListener("pointermove", move);
			element.removeEventListener("pointerleave", leave);
			element.removeEventListener("click", touch);
			leave();
			setTouches([]);
		};
	}, [active, interactive]);
	return (
		<>
			<div
				ref={host}
				className="light-avatar-background"
				data-avatar-motion={reduced ? "static" : "animated"}
				data-interactive={interactive || undefined}
				aria-hidden="true"
			/>
			{touches.length > 0 && (
				<div className="light-avatar-touches" aria-hidden="true">
					{touches.map((touch) => (
						<span
							key={touch.id}
							className="light-avatar-touch"
							data-hit={touch.hit || undefined}
							style={{ left: touch.x, top: touch.y }}
							onAnimationEnd={() =>
								setTouches((current) =>
									current.filter((t) => t.id !== touch.id),
								)
							}
						/>
					))}
				</div>
			)}
		</>
	);
}
