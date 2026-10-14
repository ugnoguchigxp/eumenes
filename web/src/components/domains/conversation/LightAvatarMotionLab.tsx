import {
	LightSpiritLab,
	type LightSpiritLabLayer,
	type LightSpiritLabMotion,
	type LightSpiritLabStatus,
} from "@eumenes/design-system";
import { useCallback, useEffect, useRef, useState } from "react";
import type { LightAvatar } from "./light-avatar/model.js";
import { loadLightAvatar, setMotionLabOnScreen } from "./light-avatar/load";

type Run = {
	mode: string;
	label: string;
	duration: number;
	elapsed: number;
	playing: boolean;
};
const idleRun: Run = {
	mode: "neutral",
	label: "",
	duration: 8,
	elapsed: 0,
	playing: false,
};

function usePageVisible() {
	const [visible, setVisible] = useState(
		() => document.visibilityState !== "hidden",
	);
	useEffect(() => {
		const changed = () => setVisible(document.visibilityState !== "hidden");
		document.addEventListener("visibilitychange", changed);
		return () => document.removeEventListener("visibilitychange", changed);
	}, []);
	return visible;
}

/**
 * Settings "表示 > アニメーション": plays every registered motion on its own canvas.
 * The renderer exists only while this tab is on screen (hidden tabs stay mounted).
 */
export function LightAvatarMotionLab() {
	const frame = useRef<HTMLDivElement>(null);
	const host = useRef<HTMLDivElement>(null);
	const model = useRef<LightAvatar | null>(null);
	const run = useRef<Run>({ ...idleRun });
	// Without IntersectionObserver the lab simply counts as on screen.
	const [onScreen, setOnScreen] = useState(
		() => typeof IntersectionObserver !== "function",
	);
	const [supported] = useState(() => Boolean(window.WebGL2RenderingContext));
	const pageVisible = usePageVisible();
	const [reduced] = useState(
		() => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
	);
	const [catalog, setCatalog] = useState<LightSpiritLabMotion[]>([]);
	const [state, setState] = useState<LightSpiritLabStatus["state"]>(() =>
		window.WebGL2RenderingContext ? "loading" : "unsupported",
	);
	const [selected, setSelected] = useState<string | null>(null);
	const [variant, setVariant] = useState("");
	const [playing, setPlaying] = useState(false);
	const [loop, setLoop] = useState(true);
	const [speed, setSpeed] = useState(1);
	const [speaking, setSpeaking] = useState(false);
	const [skeleton, setSkeleton] = useState(false);
	const [layers, setLayers] = useState<Record<LightSpiritLabLayer, boolean>>({
		secondary: true,
		gaze: true,
		gestures: true,
	});
	const [readout, setReadout] = useState<
		Pick<
			LightSpiritLabStatus,
			"motionLabel" | "variantLabel" | "elapsed" | "fps"
		>
	>({});
	// The animation loop reads the latest choices without restarting.
	const options = useRef({ loop, speed, speaking, variant, layers, skeleton });
	useEffect(() => {
		options.current = { loop, speed, speaking, variant, layers, skeleton };
	});

	useEffect(() => {
		const element = frame.current;
		if (!element || typeof IntersectionObserver !== "function") return;
		const observer = new IntersectionObserver(([entry]) =>
			setOnScreen(Boolean(entry?.isIntersecting)),
		);
		observer.observe(element);
		return () => observer.disconnect();
	}, []);

	const play = useCallback((id: string) => {
		const motion = catalogRef.current.find((m) => m.id === id);
		const avatar = model.current;
		if (!motion || !avatar) return;
		const chosen = options.current.variant;
		avatar.beginMotion(chosen ? { variant: chosen } : undefined);
		run.current = {
			mode: id,
			label: motion.label,
			duration: durations.current.get(id) ?? 8,
			elapsed: 0,
			playing: true,
		};
		setPlaying(true);
	}, []);
	const stop = useCallback(() => {
		run.current = { ...idleRun };
		setPlaying(false);
	}, []);
	const catalogRef = useRef<LightSpiritLabMotion[]>([]);
	const durations = useRef(new Map<string, number>());

	useEffect(() => {
		if (!onScreen) return;
		setMotionLabOnScreen(true);
		return () => setMotionLabOnScreen(false);
	}, [onScreen]);

	useEffect(() => {
		const element = host.current;
		if (!element || !onScreen || !pageVisible || !supported) return;
		let cancelled = false;
		let raf = 0;
		let observer: ResizeObserver | undefined;
		const fail = () => {
			setState("failed");
			release();
		};
		const release = () => {
			cancelAnimationFrame(raf);
			observer?.disconnect();
			model.current?.canvas.removeEventListener("webglcontextlost", lost);
			model.current?.dispose();
			model.current = null;
		};
		const lost = (event: Event) => {
			event.preventDefault();
			fail();
		};
		void loadLightAvatar()
			.then(({ createLightAvatar, motions, motionGroups }) => {
				if (cancelled) return;
				const avatar = createLightAvatar(element);
				model.current = avatar;
				avatar.canvas.addEventListener("webglcontextlost", lost);
				avatar.setLayers(options.current.layers);
				avatar.showSkeleton(options.current.skeleton);
				const list = motions.map((motion) => ({
					id: motion.id,
					label: motion.label,
					group: motion.group,
					groupLabel: motionGroups[motion.group],
					variants: motion.variants.map((v) => ({ id: v.id, label: v.label })),
				}));
				catalogRef.current = list;
				durations.current = new Map(motions.map((m) => [m.id, m.duration]));
				setCatalog(list);
				let staticDrawn = false;
				observer = new ResizeObserver(() => {
					if (!element.clientWidth || !element.clientHeight) return;
					// Resizing clears the canvas: the still pose must be drawn again.
					avatar.resize();
					staticDrawn = false;
				});
				observer.observe(element);
				run.current = { ...idleRun };
				setPlaying(false);
				setState("ready");
				const origin = performance.now();
				let last = origin,
					drawn = -Infinity,
					frames = 0,
					fpsWindow = origin,
					fps = 0,
					reported = 0;
				const tick = (now: number) => {
					raf = requestAnimationFrame(tick);
					if (now - drawn < 1000 / 24) return;
					drawn = now;
					const dt = Math.min(0.25, (now - last) / 1000);
					last = now;
					const current = run.current;
					const {
						speed: rate,
						loop: repeat,
						speaking: talking,
					} = options.current;
					try {
						// "Reduce motion" keeps the still pose until the viewer presses play.
						if (reduced && !current.playing) {
							if (!staticDrawn) avatar.render(0, "neutral", 1);
							staticDrawn = true;
							return;
						}
						staticDrawn = false;
						current.elapsed += dt * (current.mode === "neutral" ? 1 : rate);
						if (current.playing && current.elapsed >= current.duration) {
							if (repeat) play(current.mode);
							else stop();
						}
						const active = run.current;
						avatar.render(
							(now - origin) / 1000,
							active.mode,
							active.elapsed,
							talking,
						);
					} catch {
						fail();
						return;
					}
					frames++;
					if (now - fpsWindow >= 1000) {
						fps = Math.round((frames * 1000) / (now - fpsWindow));
						frames = 0;
						fpsWindow = now;
					}
					if (now - reported >= 250) {
						reported = now;
						const stats = avatar.stats();
						setReadout({
							motionLabel: run.current.playing ? run.current.label : undefined,
							variantLabel: String(stats.variantLabel ?? "") || undefined,
							elapsed: run.current.playing ? run.current.elapsed : undefined,
							fps,
						});
					}
				};
				raf = requestAnimationFrame(tick);
			})
			.catch(() => {
				if (!cancelled) fail();
			});
		return () => {
			cancelled = true;
			release();
			// Shown again later, the lab rebuilds its renderer.
			setState((current) => (current === "failed" ? current : "loading"));
		};
	}, [onScreen, pageVisible, supported, reduced, play, stop]);

	return (
		<div ref={frame} className="light-avatar-motion-lab">
			<LightSpiritLab
				stage={<div ref={host} aria-hidden="true" />}
				motions={catalog}
				selected={selected}
				variant={variant}
				playing={playing}
				loop={loop}
				speed={speed}
				speaking={speaking}
				layers={layers}
				skeleton={skeleton}
				status={{
					state,
					...readout,
					message: reduced
						? "動きを減らす設定のため静止しています。再生を押すと動きます。"
						: undefined,
				}}
				onSelect={(id) => {
					setSelected(id);
					setVariant("");
					options.current.variant = "";
					play(id);
				}}
				onVariant={(id) => {
					setVariant(id);
					options.current.variant = id;
					if (selected) play(selected);
				}}
				onPlay={() => selected && play(selected)}
				onRestart={() => selected && play(selected)}
				onStop={stop}
				onNeutral={stop}
				onLoop={setLoop}
				onSpeed={setSpeed}
				onSpeaking={(value) => {
					setSpeaking(value);
					options.current.speaking = value;
					// Restart the phrase so the speech layer crossfades in from its first beat.
					model.current?.beginMotion(
						options.current.variant
							? { variant: options.current.variant }
							: undefined,
					);
					run.current.elapsed = 0;
				}}
				onLayer={(layer, value) => {
					const next = { ...layers, [layer]: value };
					setLayers(next);
					model.current?.setLayers(next);
				}}
				onSkeleton={(value) => {
					setSkeleton(value);
					model.current?.showSkeleton(value);
				}}
			/>
		</div>
	);
}
