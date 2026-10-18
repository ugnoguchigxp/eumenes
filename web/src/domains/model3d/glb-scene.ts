import {
	AmbientLight,
	Box3,
	Color,
	DirectionalLight,
	HemisphereLight,
	Mesh,
	PerspectiveCamera,
	Scene,
	LoadingManager,
	Texture,
	Vector3,
	WebGLRenderer,
	type Material,
	type Object3D,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

export type GlbBackground = "light" | "dark";
const backgrounds: Record<GlbBackground, number> = {
	light: 0xf2f2f2,
	dark: 0x1b1b1f,
};

export type GlbScene = {
	/** Replaces the shown model; the previous one is released first. */
	show(glb: ArrayBuffer): Promise<void>;
	reset(): void;
	setBackground(mode: GlbBackground): void;
	capture(): Promise<Blob>;
	clear(): void;
	dispose(): void;
};

function disposeMaterial(material: Material) {
	for (const value of Object.values(material))
		if (value instanceof Texture) value.dispose();
	material.dispose();
}
/** Releases the GPU resources of a model: geometries, materials and their textures. */
export function disposeObject(root: Object3D) {
	root.traverse((node) => {
		if (!(node instanceof Mesh)) return;
		node.geometry.dispose();
		for (const material of Array.isArray(node.material)
			? node.material
			: [node.material])
			disposeMaterial(material);
	});
}

/** Draws only on change (orbit, load, resize), so an idle viewer costs nothing. */
export function createGlbScene(
	container: HTMLElement,
	background: GlbBackground,
	/** A static thumbnail uses a fixed square without resize observation. */
	thumbnailSize?: number,
): GlbScene {
	const renderer = new WebGLRenderer({ antialias: true });
	renderer.setPixelRatio(
		thumbnailSize ? 1 : Math.min(window.devicePixelRatio || 1, 2),
	);
	const canvas = renderer.domElement;
	canvas.style.display = "block";
	canvas.style.width = "100%";
	canvas.style.height = "100%";
	container.append(canvas);
	const scene = new Scene();
	scene.background = new Color(backgrounds[background]);
	const camera = new PerspectiveCamera(40, 1, 0.01, 1000);
	scene.add(
		new AmbientLight(0xffffff, 0.8),
		new HemisphereLight(0xffffff, 0x666677, 1.2),
	);
	const key = new DirectionalLight(0xffffff, 2.2);
	key.position.set(2, 3, 4);
	const fill = new DirectionalLight(0xffffff, 1);
	fill.position.set(-3, 1, -2);
	scene.add(key, fill);
	const controls = new OrbitControls(camera, canvas);
	let model: Object3D | undefined;
	let disposed = false;
	const render = () => {
		if (!disposed) renderer.render(scene, camera);
	};
	controls.addEventListener("change", render);
	const resize = () => {
		const width = thumbnailSize ?? Math.max(container.clientWidth, 1);
		const height = thumbnailSize ?? Math.max(container.clientHeight, 1);
		renderer.setSize(width, height, false);
		camera.aspect = width / height;
		camera.updateProjectionMatrix();
		render();
	};
	const observer =
		!thumbnailSize && typeof ResizeObserver === "function"
			? new ResizeObserver(resize)
			: null;
	observer?.observe(container);
	resize();
	function fit(object: Object3D) {
		const box = new Box3().setFromObject(object);
		const center = box.getCenter(new Vector3());
		const size = box.getSize(new Vector3());
		object.position.sub(center);
		const radius = Math.max(size.x, size.y, size.z, 1e-3) / 2;
		const distance = (radius / Math.tan((camera.fov * Math.PI) / 360)) * 1.5;
		camera.near = distance / 100;
		camera.far = distance * 100;
		camera.position.set(distance * 0.6, distance * 0.4, distance);
		camera.updateProjectionMatrix();
		controls.target.set(0, 0, 0);
		controls.minDistance = distance / 10;
		controls.maxDistance = distance * 10;
		controls.update();
		controls.saveState();
	}
	function release() {
		if (!model) return;
		scene.remove(model);
		disposeObject(model);
		model = undefined;
	}
	return {
		async show(glb) {
			// Everything a GLB from LARM needs is inside it; nothing is fetched from elsewhere.
			const manager = new LoadingManager();
			manager.setURLModifier((url) =>
				/^(blob|data):/.test(url) ? url : "data:,",
			);
			const gltf = await new GLTFLoader(manager).parseAsync(glb, "");
			if (disposed) {
				disposeObject(gltf.scene);
				return;
			}
			release();
			model = gltf.scene;
			scene.add(model);
			fit(model);
			render();
		},
		reset() {
			controls.reset();
			render();
		},
		setBackground(mode) {
			scene.background = new Color(backgrounds[mode]);
			render();
		},
		clear: release,
		capture() {
			if (disposed || renderer.getContext().isContextLost())
				return Promise.reject(new Error("model3d_context_lost"));
			// Capture in the same task as rendering; preserveDrawingBuffer is not needed.
			render();
			return new Promise((resolve, reject) =>
				canvas.toBlob((blob) => {
					if (blob) resolve(blob);
					else reject(new Error("model3d_thumbnail_failed"));
				}, "image/png"),
			);
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			observer?.disconnect();
			controls.dispose();
			release();
			renderer.dispose();
			renderer.forceContextLoss();
			canvas.remove();
		},
	};
}
