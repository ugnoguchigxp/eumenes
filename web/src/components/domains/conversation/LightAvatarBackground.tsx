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
	latest.current =
		cue ??
		(phase === "neutral" ? null : { key: `phase:${phase}`, motion: phase });
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
		if (!active || !visible || !element || !window.WebGL2RenderingContext)
			return;
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
			release();
		};
		void import("./light-avatar/model.js")
			.then(({ createLightAvatar }) => {
				if (cancelled) return;
				model = createLightAvatar(element);
				playback.current = createAvatarPlayback(model, {
					reduced,
					onError: release,
				});
				playback.current.setCue(latest.current);
				model.canvas.addEventListener("webglcontextlost", contextLost);
				observer = new ResizeObserver(() => {
					if (!model || !element.clientWidth || !element.clientHeight) return;
					try {
						model.resize();
						playback.current?.redraw();
					} catch {
						release();
					}
				});
				observer.observe(element);
			})
			.catch(release);
		return () => {
			cancelled = true;
			release();
		};
	}, [active, visible, reduced]);
	useEffect(() => {
		playback.current?.setCue(latest.current);
	}, [cue, phase]);
	return (
		<div ref={host} className="light-avatar-background" aria-hidden="true" />
	);
}
