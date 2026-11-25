import { useEffect, useRef, useState } from "react";
import { readAssistantMouth } from "../../../domains/audio";
import {
	createHiyori,
	readAvatarView,
	saveAvatarView,
	type AvatarBackground,
	type AvatarCue,
} from "../../../domains/avatar";
import { HiyoriViewControls } from "./HiyoriViewControls";
import "./hiyori-avatar.css";

/** The saved image and colour behind the model, with the operations that change them. */
export type AvatarBackdrop = {
	/** null: no image; the colour or the built-in gradient shows. */
	url: string | null;
	/** The saved `#rrggbb` colour; null keeps the built-in gradient. */
	color: AvatarBackground;
	/** A settings save is in flight. */
	busy: boolean;
	onPick(): void;
	onClear(): void;
	/** Resolves false when the colour was not saved. */
	onColor(color: AvatarBackground): Promise<boolean>;
	/** Removes the image and the colour together. */
	onReset(): void;
};

/** The picker reports every step of a drag; only the colour it rests on is saved. */
const colorSaveDelayMs = 300;

/** Animation stays outside React; unmount, tab hiding and context loss cancel its single loop. */
export function HiyoriAvatarBackground({
	active,
	cue = null,
	phase = "neutral",
	interactive = false,
	backdrop,
}: {
	active: boolean;
	cue?: AvatarCue | null;
	phase?: "neutral" | "listening" | "thinking";
	interactive?: boolean;
	backdrop?: AvatarBackdrop;
}) {
	const host = useRef<HTMLDivElement>(null);
	const [view, setView] = useState(readAvatarView);
	const viewRef = useRef(view);
	const saved = backdrop?.color ?? null;
	// The colour being picked shows at once; it is saved once the picker rests and nothing else is saving.
	const [picking, setPicking] = useState<{ color: AvatarBackground } | null>(
		null,
	);
	const background = picking ? picking.color : saved;
	const saveColor = useRef(backdrop?.onColor);
	useEffect(() => {
		saveColor.current = backdrop?.onColor;
	});
	const busy = backdrop?.busy ?? false;
	useEffect(() => {
		if (!picking || busy) return;
		const settle = () => setPicking((now) => (now === picking ? null : now));
		const timer = setTimeout(() => {
			const save = saveColor.current;
			if (!save || picking.color === saved) return settle();
			// Saved: the settings now hold it. Refused or failed: the saved colour shows again.
			void save(picking.color).then(settle);
		}, colorSaveDelayMs);
		return () => clearTimeout(timer);
	}, [picking, saved, busy]);
	// Switching the background away before the picker rests still saves the picked colour.
	const unsaved = useRef<AvatarBackground | undefined>(undefined);
	useEffect(() => {
		unsaved.current =
			picking && picking.color !== saved ? picking.color : undefined;
	}, [picking, saved]);
	useEffect(
		() => () => {
			if (unsaved.current !== undefined)
				void saveColor.current?.(unsaved.current);
		},
		[],
	);
	const redraw = useRef<(() => void) | undefined>(undefined);
	const latest = useRef({ cue, phase });
	useEffect(() => {
		latest.current = { cue, phase };
	}, [cue, phase]);
	useEffect(() => {
		saveAvatarView(view);
		viewRef.current = view;
		redraw.current?.();
	}, [view]);
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
						reduced.matches
							? "neutral"
							: (latest.current.cue?.motion ?? latest.current.phase),
						reduced.matches ? 0 : readAssistantMouth(),
						latest.current.cue?.intensity,
						viewRef.current,
						reduced.matches ? null : latest.current.cue,
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
		redraw.current = sync;
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
			redraw.current = undefined;
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
			style={background ? { background } : undefined}
		>
			{backdrop?.url && (
				<div
					className="hiyori-avatar-backdrop"
					style={{ backgroundImage: `url("${backdrop.url}")` }}
				/>
			)}
			<output className="hiyori-avatar-unavailable">
				桃瀬ひよりを読み込めませんでした。他の背景に切り替えて引き続き利用できます。
			</output>
			<span className="hiyori-avatar-credit">桃瀬ひより © Live2D Inc.</span>
			{interactive && active && (
				<HiyoriViewControls
					view={view}
					onChange={setView}
					background={background}
					onBackgroundChange={(color) => setPicking({ color })}
					onBackgroundReset={() => {
						setPicking(null);
						backdrop?.onReset();
					}}
					backdrop={backdrop}
				/>
			)}
		</div>
	);
}
