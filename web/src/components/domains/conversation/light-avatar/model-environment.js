// @ts-check
import * as THREE from "three";
/** @param {{own: <T>(resource: T) => T, release: (resource: any) => void, renderer: THREE.WebGLRenderer, scene: THREE.Scene}} deps */
export function installStudioEnvironment({ own, release, renderer, scene }) {
	// A small procedural studio environment supplies soft reflection bands.
	// These cards are rendered into the environment map only, never the stage.
	const studio = new THREE.Scene();
	studio.background = new THREE.Color("#03050a");
	const lightCanvas = document.createElement("canvas");
	lightCanvas.width = 64;
	lightCanvas.height = 128;
	const lightContext = /** @type {CanvasRenderingContext2D} */ (
			lightCanvas.getContext("2d")
		),
		gradient = lightContext.createRadialGradient(32, 64, 5, 32, 64, 66);
	gradient.addColorStop(0, "white");
	gradient.addColorStop(0.62, "#aaaaaa");
	gradient.addColorStop(1, "black");
	lightContext.fillStyle = gradient;
	lightContext.fillRect(0, 0, 64, 128);
	const studioTexture = own(new THREE.CanvasTexture(lightCanvas));
	for (const [
		position,
		size,
		color,
	] of /** @type {[[number, number, number], [number, number], [number, number, number]][]} */ ([
		[
			[-3, 1, 3],
			[1.1, 5.8],
			[5, 4.3, 3.3],
		],
		[
			[3, 1.2, 2],
			[1.4, 5.2],
			[2.5, 3.4, 5],
		],
		[
			[0, 4, -1],
			[4, 1.2],
			[3.8, 3.2, 2.8],
		],
		[
			[2, -1, -3],
			[0.8, 5],
			[1.9, 1.5, 1.8],
		],
	])) {
		const card = new THREE.Mesh(
			own(new THREE.PlaneGeometry(size[0], size[1])),
			own(
				new THREE.MeshBasicMaterial({
					map: studioTexture,
					color: new THREE.Color(color[0], color[1], color[2]),
					side: THREE.DoubleSide,
					toneMapped: false,
				}),
			),
		);
		card.position.set(position[0] ?? 0, position[1] ?? 0, position[2] ?? 0);
		card.lookAt(0, 0.4, 0);
		studio.add(card);
	}
	const environmentCube = own(
		new THREE.WebGLCubeRenderTarget(128, { type: THREE.HalfFloatType }),
	);
	const cubeCamera = new THREE.CubeCamera(0.1, 20, environmentCube);
	cubeCamera.update(renderer, studio);
	const pmrem = own(new THREE.PMREMGenerator(renderer)),
		environment = own(pmrem.fromCubemap(environmentCube.texture));
	scene.environment = environment.texture;
	release(environmentCube);
	release(pmrem);
	studio.traverse((/** @type {any} */ o) => {
		release(o.geometry);
		release(o.material);
	});
	release(studioTexture);
	const keyLight = new THREE.DirectionalLight("#fff0d7", 2.8);
	keyLight.position.set(-3, 4, 4);
	scene.add(keyLight);
	const fillLight = new THREE.DirectionalLight("#bcd9ff", 1.3);
	fillLight.position.set(3, 1, -2);
	scene.add(fillLight);
}
