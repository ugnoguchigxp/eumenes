import { useEffect, useRef } from "react";
import { readAssistantMouth } from "../../../domains/audio";
import { createHiyori, type AvatarCue } from "../../../domains/avatar";
import "./hiyori-avatar.css";

/** Animation stays outside React; unmount, tab hiding and context loss cancel its single loop. */
export function HiyoriAvatarBackground({
	active,
	cue = null,
}: {
	active: boolean;
	cue?: AvatarCue | null;
	phase?: string;
}) {
	const host = useRef<HTMLDivElement>(null);
	const latest = useRef(cue);
	useEffect(() => {
		latest.current = cue;
	}, [cue]);
	useEffect(() => {
		const element = host.current;
		if (!element || !active) return;
		const abort = new AbortController();
		const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
		let model: Awaited<ReturnType<typeof createHiyori>> | undefined;
		let observer: ResizeObserver | undefined;
		let frame = 0;
		let previous = -Infinity;
		const origin = performance.now();
		const stop = () => {
			cancelAnimationFrame(frame);
			frame = 0;
		};
		const release = () => {
			stop();
			observer?.disconnect();
			model?.canvas.removeEventListener("webglcontextlost", lost);
			model?.dispose();
			model = undefined;
		};
		const lost = (event: Event) => {
			event.preventDefault();
			element.dataset.avatarState = "context-lost";
			release();
		};
		const draw = (timestamp: number) => {
			frame = 0;
			if (
				!model ||
				abort.signal.aborted ||
				document.visibilityState === "hidden"
			)
				return;
			if (timestamp - previous >= 1000 / 24) {
				previous = timestamp;
				try {
					model.render(
						reduced.matches ? 0 : (timestamp - origin) / 1000,
						reduced.matches ? "neutral" : (latest.current?.motion ?? "neutral"),
						reduced.matches ? 0 : readAssistantMouth(),
						latest.current?.intensity,
					);
				} catch {
					element.dataset.avatarState = "render-failed";
					release();
					return;
				}
			}
			if (!reduced.matches) frame = requestAnimationFrame(draw);
		};
		const sync = () => {
			stop();
			previous = -Infinity;
			if (!model) return;
			element.dataset.avatarState =
				document.visibilityState === "hidden" ? "paused" : "ready";
			draw(performance.now());
		};
		element.dataset.avatarState = "loading";
		void createHiyori(element, abort.signal)
			.then((loaded) => {
				if (abort.signal.aborted) {
					loaded.dispose();
					return;
				}
				model = loaded;
				model.canvas.addEventListener("webglcontextlost", lost);
				observer = new ResizeObserver(() => {
					model?.resize();
					sync();
				});
				observer.observe(element);
				sync();
			})
			.catch(() => {
				if (!abort.signal.aborted) element.dataset.avatarState = "load-failed";
				release();
			});
		document.addEventListener("visibilitychange", sync);
		reduced.addEventListener("change", sync);
		return () => {
			abort.abort();
			release();
			document.removeEventListener("visibilitychange", sync);
			reduced.removeEventListener("change", sync);
		};
	}, [active]);
	return (
		<div
			className="hiyori-avatar-background"
			ref={host}
			data-avatar-state={active ? "loading" : "inactive"}
		>
			<output className="hiyori-avatar-unavailable">
				桃瀬ひよりを読み込めませんでした。他の背景に切り替えて引き続き利用できます。
			</output>
			<span className="hiyori-avatar-credit">桃瀬ひより © Live2D Inc.</span>
		</div>
	);
}
