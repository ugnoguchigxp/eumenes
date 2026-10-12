import {
	AmbientLight,
	DirectionalLight,
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
import { spatialModels } from "../models";
import { createPlaceholder } from "../models/placeholder";

/** One WebGL context for the background; models own only their local objects. */
export function createSpatialScene(
	host: HTMLElement,
	initialItems: readonly SpatialItem[],
	options: {
		models?: SpatialModels;
		onStatus: (status: SceneStatus) => void;
	},
) {
	const renderer = new WebGLRenderer({
		alpha: true,
		antialias: true,
		powerPreference: "low-power",
	});
	const scene = new Scene();
	const camera = new OrthographicCamera(-4, 4, 4, -4, 0.1, 100);
	camera.position.set(0, 0, 10);
	const light = new DirectionalLight(0xffffff, 2);
	light.position.set(3, 5, 8);
	scene.add(new AmbientLight(0xffffff, 1.5), light);
	const models = options.models ?? spatialModels;
	const entries = new Map<string, { item: SpatialItem; model: SpatialModel }>();
	const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
	let selected: string | null = null;
	let frame = 0,
		epoch = 0,
		lastFrame = 0,
		previousTime = 0;
	let disposed = false;
	let observer: ResizeObserver | undefined;
	let status: SceneStatus | undefined;
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
	}
	function release(model: SpatialModel) {
		scene.remove(model.object);
		try {
			model.dispose();
		} catch {
			// A broken model cannot prevent the other models/context being released.
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
	function draw() {
		if (!disposed && !document.hidden) renderer.render(scene, camera);
	}
	function moving(item: SpatialItem) {
		return (
			item.state.activity !== "idle" &&
			!item.state.stale &&
			!["disconnected", "unknown"].includes(item.state.health)
		);
	}
	function tick(time: number, generation: number) {
		if (disposed || generation !== epoch) return;
		if (time - lastFrame >= 1000 / 24) {
			try {
				const delta = previousTime
					? Math.min((time - previousTime) / 1000, 0.1)
					: 0;
				previousTime = lastFrame = time;
				for (const { item, model } of entries.values())
					if (moving(item)) model.animate?.(time / 1000, delta);
				draw();
			} catch {
				fail();
			}
		}
		if (!disposed && generation === epoch)
			frame = requestAnimationFrame((next) => tick(next, generation));
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
			notify("ready");
			if (
				!preference.matches &&
				[...entries.values()].some(
					({ item, model }) => model.animate && moving(item),
				)
			) {
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
		const aspect = width / height;
		let halfWidth = 2.5,
			halfHeight = 2;
		for (const { item } of entries.values()) {
			halfWidth = Math.max(halfWidth, Math.abs(item.position[0]) + 1);
			halfHeight = Math.max(halfHeight, Math.abs(item.position[1]) + 1);
		}
		halfHeight = Math.max(halfHeight, halfWidth / aspect);
		camera.left = -halfHeight * aspect;
		camera.right = halfHeight * aspect;
		camera.top = halfHeight;
		camera.bottom = -halfHeight;
		camera.updateProjectionMatrix();
		renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
		renderer.setSize(width, height, false);
	}
	function reconcile(items: readonly SpatialItem[]) {
		if (new Set(items.map((item) => item.id)).size !== items.length)
			throw new Error("duplicate_spatial_id");
		if (
			items.some((item) =>
				item.position.some((value) => !Number.isFinite(value)),
			)
		)
			throw new Error("invalid_spatial_position");
		const ids = new Set(items.map((item) => item.id));
		for (const [id, entry] of entries)
			if (!ids.has(id)) {
				release(entry.model);
				entries.delete(id);
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
			entry.model.object.position.set(...item.position);
			entry.model.update(item.state, item.id === selected);
		}
	}
	try {
		renderer.outputColorSpace = SRGBColorSpace;
		renderer.setClearColor(0x000000, 0);
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
		select(id: string | null) {
			if (disposed) return;
			selected = id;
			try {
				for (const { item, model } of entries.values())
					model.update(item.state, item.id === id);
				synchronize();
			} catch {
				fail();
			}
		},
	};
}
