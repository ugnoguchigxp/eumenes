import {
	LightSpiritLab,
	type LightSpiritLabLayer,
	type LightSpiritLabMotion,
	type LightSpiritLabStatus,
} from "@eumenes/design-system";
import {
	useCallback,
	useEffect,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import {
	backgroundAvatar,
	loadLightAvatar,
	setMotionLabOnScreen,
	subscribeLightAvatar,
} from "./light-avatar/load";

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
const defaultLayers: Record<LightSpiritLabLayer, boolean> = {
	secondary: true,
	gaze: true,
	gestures: true,
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
 * Settings "表示 > アニメーション": plays every registered motion on the conversation
 * background's spirit. While this tab is on screen the background's own cue playback
 * pauses and this loop drives the same model; leaving the tab hands it back.
 */
export function LightAvatarMotionLab() {
	const frame = useRef<HTMLDivElement>(null);
	const run = useRef<Run>({ ...idleRun });
	// Without IntersectionObserver the lab simply counts as on screen.
	const [onScreen, setOnScreen] = useState(
		() => typeof IntersectionObserver !== "function",
	);
	const pageVisible = usePageVisible();
	const avatar = useSyncExternalStore(subscribeLightAvatar, backgroundAvatar);
	const [reduced] = useState(
		() => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
	);
	const [catalog, setCatalog] = useState<LightSpiritLabMotion[] | null>(null);
	const [failed, setFailed] = useState(false);
	const [selected, setSelected] = useState<string | null>(null);
	const [variant, setVariant] = useState("");
	const [playing, setPlaying] = useState(false);
	const [loop, setLoop] = useState(true);
	const [speed, setSpeed] = useState(1);
	const [speaking, setSpeaking] = useState(false);
	const [skeleton, setSkeleton] = useState(false);
	const [layers, setLayers] = useState(defaultLayers);
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
	const durations = useRef(new Map<string, number>());
	const labels = useRef(new Map<string, string>());
	const driving = onScreen && pageVisible && avatar !== null && !failed;

	useEffect(() => {
		const element = frame.current;
		if (!element || typeof IntersectionObserver !== "function") return;
		const observer = new IntersectionObserver(([entry]) =>
			setOnScreen(Boolean(entry?.isIntersecting)),
		);
		observer.observe(element);
		return () => observer.disconnect();
	}, []);

	// The catalog ships with the renderer chunk; load it only once the tab is shown.
	useEffect(() => {
		if (!onScreen || catalog) return;
		let cancelled = false;
		void loadLightAvatar()
			.then(({ motions, motionGroups }) => {
				if (cancelled) return;
				durations.current = new Map(motions.map((m) => [m.id, m.duration]));
				labels.current = new Map(motions.map((m) => [m.id, m.label]));
				setCatalog(
					motions.map((motion) => ({
						id: motion.id,
						label: motion.label,
						group: motion.group,
						groupLabel: motionGroups[motion.group],
						variants: motion.variants.map((v) => ({
							id: v.id,
							label: v.label,
						})),
					})),
				);
			})
			.catch(() => {
				if (!cancelled) setFailed(true);
			});
		return () => {
			cancelled = true;
		};
	}, [onScreen, catalog]);

	const play = useCallback(
		(id: string) => {
			if (!avatar || !durations.current.has(id)) return;
			const chosen = options.current.variant;
			avatar.beginMotion(chosen ? { variant: chosen } : undefined);
			run.current = {
				mode: id,
				label: labels.current.get(id) ?? id,
				duration: durations.current.get(id)!,
				elapsed: 0,
				playing: true,
			};
			setPlaying(true);
		},
		[avatar],
	);
	const stop = useCallback(() => {
		run.current = { ...idleRun };
		setPlaying(false);
	}, []);

	useEffect(() => {
		if (!driving || !avatar) return;
		// Pauses the background's cue playback; this loop renders the model instead.
		setMotionLabOnScreen(true);
		avatar.setLayers(options.current.layers);
		avatar.showSkeleton(options.current.skeleton);
		avatar.beginMotion();
		const origin = performance.now();
		let raf = 0,
			last = origin,
			drawn = -Infinity,
			frames = 0,
			fpsWindow = origin,
			fps = 0,
			reported = 0;
		const tick = (now: number) => {
			raf = requestAnimationFrame(tick);
			const current = run.current;
			// "Reduce motion" keeps the still pose (redrawn after resizes) until play.
			const still = reduced && !current.playing;
			if (now - drawn < 1000 / (still ? 4 : 24)) return;
			drawn = now;
			const dt = Math.min(0.25, (now - last) / 1000);
			last = now;
			const { speed: rate, loop: repeat, speaking: talking } = options.current;
			try {
				if (still) {
					avatar.render(0, "neutral", 1);
					return;
				}
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
				cancelAnimationFrame(raf);
				setFailed(true);
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
		return () => {
			cancelAnimationFrame(raf);
			// Hand the spirit back as the conversation left it.
			run.current = { ...idleRun };
			setPlaying(false);
			avatar.setLayers(defaultLayers);
			avatar.showSkeleton(false);
			avatar.beginMotion();
			setMotionLabOnScreen(false);
		};
	}, [driving, avatar, reduced, play, stop]);

	const state: LightSpiritLabStatus["state"] = failed
		? "failed"
		: !catalog
			? "loading"
			: avatar
				? "ready"
				: "unavailable";
	const message =
		state === "unavailable"
			? "会話の背景の光の精霊が表示されていません。背景を「光の妖精」にして会話画面と並べて開くと、ここから動かせます。"
			: state === "ready"
				? reduced
					? "動きを減らす設定のため静止しています。再生を押すと会話の背景の精霊が動きます。"
					: "会話の背景の精霊で再生しています。"
				: undefined;
	return (
		<div ref={frame} className="light-avatar-motion-lab">
			<LightSpiritLab
				motions={catalog ?? []}
				selected={selected}
				variant={variant}
				playing={playing}
				loop={loop}
				speed={speed}
				speaking={speaking}
				layers={layers}
				skeleton={skeleton}
				status={{ state, ...(state === "ready" ? readout : {}), message }}
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
					avatar?.beginMotion(
						options.current.variant
							? { variant: options.current.variant }
							: undefined,
					);
					run.current.elapsed = 0;
				}}
				onLayer={(layer, value) => {
					const next = { ...layers, [layer]: value };
					setLayers(next);
					avatar?.setLayers(next);
				}}
				onSkeleton={(value) => {
					setSkeleton(value);
					avatar?.showSkeleton(value);
				}}
			/>
		</div>
	);
}
