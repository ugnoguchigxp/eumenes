import { useEffect, useRef, useState } from "react";
import type { LightAvatar } from "./light-avatar/model.js";
import { createAvatarPlayback, type AvatarCue } from "../../../domains/avatar";

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
	useEffect(() => {
		const element = host.current;
		if (!element) return;
		element.dataset.avatarState = !active || !visible ? "inactive" : "loading";
		if (!active || !visible) return;
		if (!window.WebGL2RenderingContext) {
			element.dataset.avatarState = "unsupported";
			return;
		}
		let cancelled = false;
		let model: LightAvatar | undefined;
		let observer: ResizeObserver | undefined;
		const release = () => {
			observer?.disconnect();
			playback.current?.dispose();
			playback.current = null;
			model?.canvas.removeEventListener("webglcontextlost", contextLost);
			model?.dispose();
			model = undefined;
		};
		const contextLost = (event: Event) => {
			event.preventDefault();
			element.dataset.avatarState = "context-lost";
			release();
		};
		void import("./light-avatar/model.js")
			.then(({ createLightAvatar }) => {
				if (cancelled) return;
				model = createLightAvatar(element);
				const controller = createAvatarPlayback(model, {
					reduced,
					onError: () => {
						element.dataset.avatarState = "render-failed";
						release();
					},
				});
				if (!model) {
					controller.dispose();
					return;
				}
				playback.current = controller;
				element.dataset.avatarState = "ready";
				playback.current.setCue(latest.current);
				if (!model) return;
				model.canvas.addEventListener("webglcontextlost", contextLost);
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
		return () => {
			cancelled = true;
			release();
		};
	}, [active, visible, reduced]);
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
