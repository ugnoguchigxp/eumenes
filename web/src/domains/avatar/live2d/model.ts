import { loadCubismCore } from "./load";
import type { AvatarMotion } from "../../../../../api/domains/delivery/contracts";
import { createFace } from "./face";
import { idleParameters } from "./idle";
import { defaultAvatarView, type AvatarView } from "../view";

const contexts = new Set<WebGLRenderingContext>();
const home = "/live2d/hiyori/";
async function bytes(path: string, signal: AbortSignal) {
	const response = await fetch(home + path, { signal });
	if (!response.ok) throw new Error("avatar_asset_unavailable");
	return response.arrayBuffer();
}

/** One WebGL canvas, owned by its mounted background; audio is always owned elsewhere. */
export async function createHiyori(host: HTMLElement, signal: AbortSignal) {
	await loadCubismCore();
	signal.throwIfAborted();
	const sdk = await import("../../../../../vendor/live2d/framework.js");
	if (!sdk.CubismFramework.isInitialized()) {
		if (!sdk.CubismFramework.startUp())
			throw new Error("avatar_sdk_unavailable");
		sdk.CubismFramework.initialize();
	}
	const response = await fetch(home + "Hiyori.model3.json", { signal });
	if (!response.ok) throw new Error("avatar_asset_unavailable");
	const setting = (await response.json()) as {
		FileReferences: {
			Moc: string;
			Textures: string[];
			Physics: string;
			Pose: string;
		};
	};
	const [mocBytes, physicsBytes, poseBytes] = await Promise.all([
		bytes(setting.FileReferences.Moc, signal),
		bytes(setting.FileReferences.Physics, signal),
		bytes(setting.FileReferences.Pose, signal),
	]);
	signal.throwIfAborted();
	const moc = sdk.CubismMoc.create(mocBytes, true);
	if (!moc) throw new Error("avatar_model_invalid");
	const model = moc.createModel();
	if (!model) {
		moc.release();
		throw new Error("avatar_model_invalid");
	}
	const canvas = document.createElement("canvas");
	const gl = canvas.getContext("webgl", {
		alpha: true,
		premultipliedAlpha: true,
		antialias: true,
	});
	if (!gl) {
		moc.deleteModel(model);
		moc.release();
		throw new Error("avatar_webgl_unavailable");
	}
	const renderer = new sdk.CubismRenderer_WebGL();
	const textures: WebGLTexture[] = [];
	const physics = sdk.CubismPhysics.create(
		physicsBytes,
		physicsBytes.byteLength,
	);
	const pose = sdk.CubismPose.create(poseBytes, poseBytes.byteLength);
	let disposed = false;
	const dispose = () => {
		if (disposed) return;
		disposed = true;
		renderer.release();
		for (const texture of textures) gl.deleteTexture(texture);
		sdk.CubismPhysics.delete(physics);
		sdk.CubismPose.delete(pose);
		moc.deleteModel(model);
		moc.release();
		// Release the SDK's per-context shader cache, then the context itself.
		contexts.delete(gl);
		if (!contexts.size) sdk.CubismShaderManager_WebGL.deleteInstance();
		gl.getExtension("WEBGL_lose_context")?.loseContext();
		canvas.remove();
	};
	try {
		renderer.initialize(model);
		renderer.startUp(gl);
		contexts.add(gl);
		renderer.setIsPremultipliedAlpha(true);
		for (const [index, path] of setting.FileReferences.Textures.entries()) {
			const data = await bytes(path, signal);
			const bitmap = await createImageBitmap(new Blob([data]), {
				premultiplyAlpha: "premultiply",
			});
			try {
				signal.throwIfAborted();
				const texture = gl.createTexture();
				if (!texture) throw new Error("avatar_texture_failed");
				textures.push(texture);
				gl.bindTexture(gl.TEXTURE_2D, texture);
				gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 1);
				gl.texImage2D(
					gl.TEXTURE_2D,
					0,
					gl.RGBA,
					gl.RGBA,
					gl.UNSIGNED_BYTE,
					bitmap,
				);
				gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
				gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
				gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
				gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
				renderer.bindTexture(index, texture);
			} finally {
				bitmap.close();
			}
		}
		signal.throwIfAborted();
		model.saveParameters();
		const face = createFace();
		const ids = new Map<
			string,
			import("../../../../../vendor/live2d/framework.js").Id
		>();
		const id = (key: string) => {
			if (!ids.has(key))
				ids.set(key, sdk.CubismFramework.getIdManager().getId(key));
			return ids.get(key)!;
		};
		const set = (key: string, value: number) =>
			model.setParameterValueById(id(key), value);
		const matrix = new sdk.CubismModelMatrix(
			model.getCanvasWidth(),
			model.getCanvasHeight(),
		);
		matrix.setHeight(1.85);
		let last = 0;
		let mouth = 0;
		const resize = () => {
			const ratio = Math.min(1.5, window.devicePixelRatio || 1);
			canvas.width = Math.max(1, Math.round(host.clientWidth * ratio));
			canvas.height = Math.max(1, Math.round(host.clientHeight * ratio));
		};
		host.append(canvas);
		resize();
		return {
			canvas,
			resize,
			dispose,
			render(
				time: number,
				motion: AvatarMotion,
				mouthOpen: number,
				intensity = 1,
				view: AvatarView = defaultAvatarView,
			) {
				if (disposed) return;
				const dt = Math.min(0.1, Math.max(0, time - last));
				last = time;
				model.loadParameters();
				for (const [key, value] of Object.entries(idleParameters(time)))
					set(key, value);
				physics.evaluate(model, dt);
				const values = face(time, dt, motion, mouthOpen, intensity);
				for (const [key, value] of Object.entries(values)) set(key, value);
				mouth = values.ParamMouthOpenY;
				pose.updateParameters(model, dt);
				model.update();
				gl.viewport(0, 0, canvas.width, canvas.height);
				gl.clearColor(0, 0, 0, 0);
				gl.clear(gl.COLOR_BUFFER_BIT);
				const projection = new sdk.CubismMatrix44();
				projection.scale((canvas.height / canvas.width) * view.zoom, view.zoom);
				// Anchor the zoom near the head (10% from the top), cropping below it.
				projection.translate(view.x * 2, 0.8 * (1 - view.zoom) - view.y * 2);
				projection.multiplyByMatrix(matrix);
				renderer.setMvpMatrix(projection);
				renderer.setRenderState(null, [0, 0, canvas.width, canvas.height]);
				renderer.drawModel("/live2d/shaders/");
			},
			stats: () => ({
				mouthOpen: mouth,
				eyeOpen: model.getParameterValueById(id("ParamEyeLOpen")),
				textures: textures.length,
			}),
		};
	} catch (error) {
		dispose();
		throw error;
	}
}
