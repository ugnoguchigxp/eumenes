import {
	OrthographicCamera,
	Scene,
	SRGBColorSpace,
	WebGLRenderer,
} from "three";
import type {
	SceneStatus,
	SpatialItem,
	SpatialModel,
	SpatialModels,
} from "../contracts";
import {
	defaultSpatialOptions,
	normalizeOptions,
	type SpatialOptions,
	activityStrength,
} from "../options";
import { createPlaceholder } from "../models/placeholder";
import { createCameraController } from "./camera";
import { fitEnvelope } from "./placement";

/** One context, one loop, immutable point buffers; the scene owns layout separately from model motion. */
export function createSpatialScene(
	host: HTMLElement,
	initialItems: readonly SpatialItem[],
	options: {
		models?: SpatialModels;
		settings?: Partial<SpatialOptions>;
		onStatus: (status: SceneStatus) => void;
	},
) {
	const renderer = new WebGLRenderer({
		alpha: true,
		antialias: false,
		powerPreference: "low-power",
	});
	const scene = new Scene();
	const camera = new OrthographicCamera(-15, 15, 15, -15, 0.1, 100);
	const view = createCameraController(camera);
	const models = options.models ?? {};
	const envelope = { x: 1, y: 1, z: 1, focusRadius: 1 };
	const entries = new Map<string, { item: SpatialItem; model: SpatialModel }>();
	const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
	let settings = normalizeOptions(options.settings ?? defaultSpatialOptions);
	let selected: string | null = null;
	let retainedFocus: string | null = null;
	let frame = 0,
		epoch = 0,
		lastFrame = 0,
		previousTime = 0,
		orbit = 0,
		seconds = 0;
	let disposed = false;
	let observer: ResizeObserver | undefined;
	let status: SceneStatus | undefined;
	const reduced = () => settings.reducedMotion || preference.matches;
	const motionEnabled = () => !settings.paused && !reduced();
	function notify(next: SceneStatus) {
		if (status === next) return;
		status = next;
		options.onStatus(next);
	}
	function stop() {
		epoch++;
		cancelAnimationFrame(frame);
		frame = 0;
		previousTime = 0;
		lastFrame = 0;
	}
	function release(model: SpatialModel) {
		scene.remove(model.object);
		try {
			model.dispose();
		} catch {
			/* Other models still need to be released. */
		}
	}
	function dispose() {
		if (disposed) return;
		disposed = true;
		stop();
		observer?.disconnect();
		document.removeEventListener("visibilitychange", synchronize);
		preference.removeEventListener("change", synchronize);
		renderer.domElement.removeEventListener("webglcontextlost", contextLost);
		renderer.domElement.remove();
		for (const { model } of entries.values()) release(model);
		entries.clear();
		try {
			renderer.dispose();
		} finally {
			renderer.forceContextLoss();
		}
	}
	function fail() {
		dispose();
		notify("failed");
	}
	function contextLost(event: Event) {
		event.preventDefault();
		fail();
	}
	function place() {
		for (const { item, model } of entries.values()) {
			if (!item.orbit) model.object.position.set(...item.position);
			else {
				const angle = item.orbit.phase + orbit * (item.orbit.speed ?? 1);
				model.object.position.set(
					Math.cos(angle) * item.orbit.radius,
					Math.sin(angle) * item.orbit.radius,
					item.position[2],
				);
			}
		}
	}
	function draw(dt = 0) {
		if (disposed || document.hidden) return;
		place();
		fitEnvelope(entries.values(), settings, selected, envelope);
		const focus = selected
			? entries.get(selected)?.model.object.position
			: undefined;
		const blend = view.update(dt, settings, focus, envelope, reduced());
		for (const { item, model } of entries.values())
			model.configure?.(
				settings,
				settings.core +
					((retainedFocus === item.id ? settings.focusCore : settings.core) -
						settings.core) *
						view.focusAmount,
				motionEnabled(),
				!selected || selected === item.id ? 1 : 1 - 0.85 * blend,
			);
		renderer.render(scene, camera);
	}
	function moving(item: SpatialItem) {
		return activityStrength(item.state) > 0;
	}
	function needsLoop() {
		return (
			view.pending ||
			(motionEnabled() &&
				[...entries.values()].some(
					({ item, model }) =>
						(item.orbit && settings.orbitSpeed > 0) ||
						(model.animate && (moving(item) || model.configure)),
				))
		);
	}
	function tick(time: number, generation: number) {
		if (disposed || generation !== epoch) return;
		if (time - lastFrame >= 1000 / 30) {
			try {
				const delta = previousTime
					? Math.min((time - previousTime) / 1000, 0.05)
					: 0;
				previousTime = lastFrame = time;
				if (motionEnabled()) {
					seconds = (seconds + delta) % 33600;
					orbit =
						(orbit + ((0.025 * settings.orbitSpeed) / 100) * delta) %
						(Math.PI * 8);
					for (const { item, model } of entries.values())
						if (moving(item) || model.configure)
							model.animate?.(seconds, delta);
				}
				draw(delta);
			} catch {
				fail();
			}
		}
		if (!disposed && generation === epoch && needsLoop())
			frame = requestAnimationFrame((next) => tick(next, generation));
		else frame = 0;
	}
	function synchronize() {
		if (disposed) return;
		stop();
		if (document.hidden) {
			notify("paused");
			return;
		}
		try {
			draw();
			notify(settings.paused ? "paused" : "ready");
			if (needsLoop()) {
				const generation = epoch;
				frame = requestAnimationFrame((time) => tick(time, generation));
			}
		} catch {
			fail();
		}
	}
	function resize() {
		const { width, height } = host.getBoundingClientRect();
		if (!width || !height || disposed) return;
		view.resize(width, height);
		renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
		renderer.setSize(width, height, false);
	}
	function reconcile(items: readonly SpatialItem[]) {
		if (new Set(items.map((item) => item.id)).size !== items.length)
			throw new Error("duplicate_spatial_id");
		if (
			items.some(
				(item) =>
					item.position.some((value) => !Number.isFinite(value)) ||
					(item.orbit &&
						[item.orbit.radius, item.orbit.phase, item.orbit.speed ?? 1].some(
							(value) => !Number.isFinite(value),
						)),
			)
		)
			throw new Error("invalid_spatial_position");
		const ids = new Set(items.map((item) => item.id));
		for (const [id, entry] of entries)
			if (!ids.has(id)) {
				release(entry.model);
				entries.delete(id);
			}
		if (selected && !ids.has(selected)) {
			selected = null;
			view.begin();
		}
		for (const item of items) {
			let entry = entries.get(item.id);
			if (entry && entry.item.model !== item.model) {
				release(entry.model);
				entries.delete(item.id);
				entry = undefined;
			}
			if (!entry) {
				const factory = Object.hasOwn(models, item.model)
					? models[item.model]
					: undefined;
				entry = { item, model: (factory ?? createPlaceholder)() };
				entries.set(item.id, entry);
				scene.add(entry.model.object);
			}
			entry.item = item;
			entry.model.update(item.state, item.id === selected);
		}
	}
	try {
		renderer.outputColorSpace = SRGBColorSpace;
		renderer.setClearColor(0x0b1018, 1);
		renderer.domElement.setAttribute("aria-hidden", "true");
		host.append(renderer.domElement);
		reconcile(initialItems);
		resize();
		observer = new ResizeObserver(() => {
			try {
				resize();
				synchronize();
			} catch {
				fail();
			}
		});
		observer.observe(host);
		document.addEventListener("visibilitychange", synchronize);
		preference.addEventListener("change", synchronize);
		renderer.domElement.addEventListener("webglcontextlost", contextLost);
		synchronize();
	} catch (error) {
		dispose();
		throw error;
	}
	return {
		dispose,
		setItems(items: readonly SpatialItem[]) {
			if (disposed) return;
			try {
				reconcile(items);
				resize();
				synchronize();
			} catch {
				fail();
			}
		},
		setOptions(next: Partial<SpatialOptions>) {
			if (disposed) return;
			settings = normalizeOptions(next);
			view.begin();
			synchronize();
		},
		select(id: string | null) {
			if (disposed) return;
			selected = id && entries.has(id) ? id : null;
			if (selected) retainedFocus = selected;
			view.begin();
			try {
				for (const { item, model } of entries.values())
					model.update(item.state, item.id === selected);
				synchronize();
			} catch {
				fail();
			}
		},
	};
}
