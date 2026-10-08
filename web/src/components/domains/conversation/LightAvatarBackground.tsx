import { useEffect, useRef, useState } from "react";
import type { LightAvatar } from "./light-avatar/model.js";

export function LightAvatarBackground({ active }: { active: boolean }) {
	const host = useRef<HTMLDivElement>(null);
	const [visible, setVisible] = useState(
		() => document.visibilityState !== "hidden",
	);
	useEffect(() => {
		const changed = () => setVisible(document.visibilityState !== "hidden");
		document.addEventListener("visibilitychange", changed);
		return () => document.removeEventListener("visibilitychange", changed);
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
				model.canvas.addEventListener("webglcontextlost", contextLost);
				observer = new ResizeObserver(() => {
					if (!model || !element.clientWidth || !element.clientHeight) return;
					try {
						model.resize();
						model.render();
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
	}, [active, visible]);
	return (
		<div ref={host} className="light-avatar-background" aria-hidden="true" />
	);
}
