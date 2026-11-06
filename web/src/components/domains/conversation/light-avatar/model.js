import { installStudioEnvironment } from "./model-environment.js";
import { createAvatarGeometry } from "./model-geometry.js";
import { createAvatarHitTest } from "./model-hit-test.js";
import { createAvatarMaterials } from "./model-materials.js";
// @ts-check
// Model-local aliases remain loose; Three.js itself uses its published type definitions.
/** @typedef {any} ThreeColor A color accepted by THREE.Color. */
/** @typedef {any} ThreeObject A THREE.Object3D / Vector3 / Curve instance. */
import * as THREE from "three";
import { createPerformer, defaultLayers } from "./performer.ts";
import { createSecondaryMotion } from "./secondary.ts";
import {
	armInfluence,
	boneNames,
	createSkeleton,
	setInfluences,
} from "./skeleton.ts";

// The motion catalog ships with the renderer chunk so the lab never loads three.js early.
export { motionGroups } from "./clips.ts";
export { motions } from "./motions/index.ts";
const TAU = Math.PI * 2;
const clamp = THREE.MathUtils.clamp;
// Every skinned vertex follows its two bones, then keeps the faint living shimmer.
/** @param {HTMLElement} host */
export function createLightAvatar(host) {
	const renderer = new THREE.WebGLRenderer({
		antialias: true,
		alpha: true,
		premultipliedAlpha: true,
		powerPreference: "low-power",
	});

	/** @type {Set<{ dispose(): void }>} */
	const resources = new Set();
	/**
	 * @template T
	 * @param {T} resource
	 * @returns {T}
	 */
	const own = (resource) => {
		resources.add(
			/** @type {{ dispose(): void }} */ (/** @type {unknown} */ (resource)),
		);
		return resource;
	};
	/** @param {any} resource */
	const release = (resource) => {
		if (resources.delete(resource)) resource.dispose();
	};
	let disposed = false;
	function dispose() {
		if (disposed) return;
		disposed = true;
		// Detach promptly even if GPU resource cleanup is slow or throws.
		renderer.domElement.remove();
		for (const resource of resources) release(resource);
		renderer.dispose();
		renderer.forceContextLoss();
	}
	try {
		renderer.info.autoReset = false;
		renderer.debug.onShaderError = (
			/** @type {any} */ gl,
			/** @type {any} */ _program,
			/** @type {any} */ vs,
			/** @type {any} */ fs,
		) => {
			throw new Error(
				"3D shader: " + gl.getShaderInfoLog(vs) + " " + gl.getShaderInfoLog(fs),
			);
		};
		renderer.setPixelRatio(Math.min(devicePixelRatio, 1.25));
		renderer.setClearColor(0x000000, 0);
		renderer.outputColorSpace = THREE.SRGBColorSpace;
		renderer.toneMapping = THREE.ACESFilmicToneMapping;
		renderer.toneMappingExposure = 1.1;
		renderer.domElement.setAttribute("aria-hidden", "true");
		host.append(renderer.domElement);

		const scene = new THREE.Scene();
		const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
		// Framed with headroom for jumps, spins and wide-open arms.
		camera.position.set(0, 0.32, 8.5);
		camera.lookAt(0, 0.22, 0);
		const uniforms = {
			uTime: { value: 0 },
			uEnergy: { value: 0.1 },
			/** Accumulated particle drift; light.swirl speeds it up without jumps. */
			uFlow: { value: 0 },
			uSparkle: { value: 0 },
			uBoneTexture: { value: /** @type {THREE.Texture | null} */ (null) },
		};
		const root = new THREE.Group();
		scene.add(root);
		const palettes = {
			gold: new THREE.Color("#ffdca2"),
			white: new THREE.Color("#fff2d7"),
			blue: new THREE.Color("#b3dbff"),
		};
		let seed = 97245;
		const random = () => {
			seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
			return seed / 4294967296;
		};
		const gaussian = () =>
			Math.sqrt(-2 * Math.log(Math.max(0.00001, random()))) *
			Math.cos(TAU * random());
		/** @type {THREE.Material[]} */
		const materials = [];
		installStudioEnvironment({ own, release, renderer, scene });
		const {
			spiritGlass,
			foldGlass,
			surfaceMaterial,
			lineMaterial,
			makePoints,
			glow,
		} = createAvatarMaterials({ own, uniforms, renderer, materials, random });
		const {
			profile,
			shellPoint,
			byHeight,
			heightInfluences,
			shellGeometry,
			ribbonGeometry,
		} = createAvatarGeometry(own);
		/**
		 * Eyes ride the `eyes` bone; gaze and openness are set per frame.
		 * @param {ThreeObject} group
		 * @param {THREE.Bone} socket
		 */
		function addReferenceEyes(group, socket) {
			group.userData.eyes = [];
			/** @type {[number, number, number][]} */
			const eyes = [
				[-0.21, 1.4, 0.55],
				[0.21, 1.4, 0.55],
			];
			for (const [x, y, z] of eyes) {
				const eye = new THREE.Mesh(
					own(new THREE.CapsuleGeometry(0.022, 0.09, 6, 10)),
					own(new THREE.MeshBasicMaterial({ color: "#fff2b4" })),
				);
				eye.position.set(x, y, z + 0.02).sub(skeleton.bindPosition("eyes"));
				eye.rotation.z = x < 0 ? -0.12 : 0.12;
				socket.add(eye);
				const g = glow(palettes.gold, 0.16);
				g.position.copy(eye.position);
				socket.add(g);
				for (const part of [eye, g]) {
					part.userData.rest = part.position.clone();
					part.userData.isGlow = part === g;
				}
				group.userData.eyes.push(eye, g);
			}
		}
		// Arm curves live in the flame's space; their quarter points become the arm joints.
		const armCurves = /** @type {const} */ (["outer", "inner"]).flatMap(
			(layer) =>
				/** @type {const} */ ([-1, 1]).map((side) => {
					const points =
						layer === "outer"
							? [
									[side * 0.2, 0.33, -0.08],
									[side * 0.64, 0.59, -0.02],
									[side * 0.94, 0.99, 0.03],
									[side * 0.99, 1.35, 0.04],
									[side * 0.88, 1.58, 0.09],
								]
							: [
									[side * 0.14, 0.18, 0.28],
									[side * 0.43, 0.32, 0.35],
									[side * 0.68, 0.62, 0.39],
									[side * 0.72, 0.92, 0.43],
									[side * 0.59, 1.14, 0.44],
								];
					const curve = new THREE.CatmullRomCurve3(
						points.map(
							(p) =>
								new THREE.Vector3(
									/** @type {number} */ (p[0]),
									/** @type {number} */ (p[1]),
									/** @type {number} */ (p[2]),
								),
						),
					);
					return { layer, side, curve };
				}),
		);
		const skeleton = createSkeleton(
			armCurves.map(({ layer, side, curve }) => ({
				layer,
				side,
				joints:
					/** @type {[[number, number, number], [number, number, number], [number, number, number], [number, number, number]]} */ (
						[0, 1 / 3, 2 / 3, 1].map((u) => curve.getPoint(u).toArray())
					),
			})),
		);
		uniforms.uBoneTexture.value = skeleton.texture;
		own(skeleton.texture);
		const bone = (/** @type {import("./skeleton.ts").BoneName} */ name) =>
			/** @type {THREE.Bone} */ (skeleton.bones.get(name));
		/** @param {string} kind */
		function makeFlame(kind) {
			const group = new THREE.Group();
			group.add(skeleton.root);
			const body = new THREE.Mesh(shellGeometry(kind), spiritGlass);
			group.add(body);
			{
				// The body and lower head are symmetric; the crown curls from the upper head itself.
				// Reference imagery informs color, never the projected front silhouette.
				const skin = [],
					headGlow = [];
				for (let n = 0; n < 6000; n += 2) {
					const u = random(),
						phi = random() * TAU,
						p = shellPoint(u, phi, "b", 1 + gaussian() * 0.012);
					const cx = profile(u, "b")[1];
					if (p.y < 0.5) {
						const v = clamp((p.y + 1.96) / 2.55, 0, 1),
							envelope = 0.012 + 0.5 * Math.pow(Math.sin(v * Math.PI), 0.8),
							ratio = envelope / profile(u, "b")[2];
						p.x = cx + (p.x - cx) * ratio;
						p.z *= ratio;
					}
					skin.push([p.x, p.y, p.z], [2 * cx - p.x, p.y, p.z]);
				}
				group.add(
					makePoints(skin, palettes.gold, heightInfluences(skin), 0.6, 0.28),
				);
				for (let n = 0; n < 1000; n += 2) {
					const u = 0.67 + random() * 0.29,
						phi = random() * TAU,
						p = shellPoint(u, phi, "b", 0.98);
					const cx = profile(u, "b")[1];
					headGlow.push([p.x, p.y, p.z], [2 * cx - p.x, p.y, p.z]);
				}
				group.add(
					makePoints(
						headGlow,
						palettes.white,
						heightInfluences(headGlow),
						0.5,
						0.14,
					),
				);
				const luminousVeil = new THREE.Mesh(
					shellGeometry("b"),
					surfaceMaterial(palettes.white, 0.15, true, true),
				);
				group.add(luminousVeil);
			}
			const strandCount = kind === "b" ? 28 : 18;
			for (let n = 0; n < strandCount; n++) {
				const points = [];
				const offset = (n / strandCount) * TAU;
				for (let j = 0; j < 120; j++) {
					const u = 0.018 + (j / 119) * 0.967;
					points.push(
						shellPoint(
							u,
							offset + u * (n % 2 ? 8 : -7) + Math.sin(u * 7 + n) * 0.45,
							kind,
							1.015,
						),
					);
				}
				group.add(
					new THREE.Line(
						byHeight(own(new THREE.BufferGeometry()).setFromPoints(points)),
						lineMaterial(
							n % 7 === 0 ? palettes.blue : palettes.gold,
							kind === "b"
								? n % 5 === 0
									? 0.06
									: 0.028
								: n % 5 === 0
									? 0.16
									: 0.065,
						),
					),
				);
			}
			const particles = [];
			for (let n = 0; n < 2500; n++) {
				const u = random(),
					phi = random() * TAU;
				const p = shellPoint(
					u,
					phi,
					kind,
					random() < 0.82 ? 1 + gaussian() * 0.05 : 1 + random() * 0.35,
				);
				particles.push([p.x, p.y, p.z]);
			}
			group.add(
				makePoints(
					particles,
					palettes.gold,
					heightInfluences(particles),
					0.82,
					0.5,
				),
			);
			addReferenceEyes(group, bone("eyes"));
			// The core and its orbits are rigid children of the core bone, which sits at the core.
			const core = glow(palettes.gold, 0.65);
			bone("core").add(core);
			group.userData.core = core;
			const star = new THREE.Mesh(
				own(new THREE.SphereGeometry(0.056, 16, 10)),
				own(new THREE.MeshBasicMaterial({ color: "#fff4ca" })),
			);
			bone("core").add(star);
			group.userData.star = star;
			const inner = [];
			for (let n = 0; n < 500; n++) {
				const r = 0.43 * Math.pow(random(), 0.5),
					a = random() * TAU,
					z = random() * 0.5;
				inner.push([Math.cos(a) * r, Math.sin(a) * r, z - 0.4]);
			}
			bone("core").add(makePoints(inner, palettes.white, null, 0.7, 0.4));
			if (kind === "b") {
				addArms(group);
				addCoreParticles(bone("core"));
			}
			return group;
		}
		/** @param {ThreeObject} group */
		function addArms(group) {
			const arms = [];
			for (const { layer, side, curve } of armCurves) {
				const isOuter = layer === "outer";
				/** @param {number} u */
				const along = (u) => armInfluence(layer, side, u);
				const ribbon = ribbonGeometry(curve, isOuter ? 0.175 : 0.11, 0, 0.3);
				const uv = ribbon.getAttribute("uv");
				setInfluences(
					ribbon,
					Array.from({ length: uv.count }, (_, i) => along(uv.getY(i))),
				);
				group.add(new THREE.Mesh(ribbon, foldGlass));
				for (let k = 0; k < 3; k++) {
					const points2 = [],
						weights = [];
					for (let j = 0; j < 80; j++) {
						const u = j / 79,
							p = curve.getPoint(u);
						p.z += Math.sin(u * 7 + k) * 0.016;
						p.x += Math.sin(u * Math.PI) * (k - 1) * 0.011;
						points2.push(p);
						weights.push(along(u));
					}
					const geometry = setInfluences(
						own(new THREE.BufferGeometry()).setFromPoints(points2),
						weights,
					);
					group.add(
						new THREE.Line(geometry, lineMaterial(palettes.gold, 0.18)),
					);
				}
				const grains = [],
					grainWeights = [];
				for (let n = 0; n < 240; n++) {
					const u = random(),
						p = curve.getPoint(u),
						t = curve.getTangent(u),
						sideVector = new THREE.Vector3(-t.y, t.x, 0).normalize(),
						r = (isOuter ? 0.175 : 0.11) * Math.pow(Math.sin(u * Math.PI), 0.7);
					p.addScaledVector(sideVector, (random() * 2 - 1) * r * 0.8);
					p.z += gaussian() * 0.018;
					grains.push([p.x, p.y, p.z]);
					grainWeights.push(along(u));
				}
				group.add(makePoints(grains, palettes.gold, grainWeights, 0.65, 0.4));
				const tipName = /** @type {import("./skeleton.ts").BoneName} */ (
					`arm_${layer}_${side < 0 ? "l" : "r"}_tip`
				);
				const tip = glow(palettes.gold, isOuter ? 0.135 : 0.105);
				bone(tipName).add(tip);
				arms.push({ layer, side, tip, bone: bone(tipName), size: tip.scale.x });
			}
			group.userData.arms = arms;
			// Open, overlapping waist membranes curl around the luminous center and meet at a narrow hem.
			for (const side of [-1, 1])
				for (const layer of [0, 1]) {
					const points =
						layer === 0
							? [
									[side * 0.18, 0.48, 0.12],
									[side * 0.39, 0.08, 0.29],
									[side * 0.56, -0.48, 0.15],
									[side * 0.45, -1.03, 0.25],
									[side * 0.2, -1.6, 0.03],
									[0, -1.96, 0],
								]
							: [
									[side * 0.14, 0.26, 0.31],
									[side * 0.43, -0.12, 0.44],
									[side * 0.25, -0.54, 0.43],
									[-side * 0.12, -0.96, 0.25],
									[-side * 0.15, -1.35, 0.18],
									[0, -1.96, 0],
								];
					const curve = new THREE.CatmullRomCurve3(
							points.map((p) => new THREE.Vector3(...p)),
						),
						geo = ribbonGeometry(
							curve,
							layer === 0 ? 0.31 : 0.19,
							side * (layer === 0 ? 1.0 : -1.1),
						);
					byHeight(geo);
					group.add(new THREE.Mesh(geo, foldGlass));
					group.add(
						new THREE.Mesh(geo, surfaceMaterial(palettes.gold, 0.07, true)),
					);
					for (let k = 0; k < 3; k++) {
						const line = [];
						for (let j = 0; j < 100; j++) {
							const u = j / 99,
								p = curve.getPoint(u);
							p.x += side * Math.sin(u * Math.PI) * (k - 1) * 0.035;
							line.push(p);
						}
						group.add(
							new THREE.Line(
								byHeight(own(new THREE.BufferGeometry()).setFromPoints(line)),
								lineMaterial(k === 0 ? palettes.blue : palettes.gold, 0.085),
							),
						);
					}
				}
		}
		/** @param {ThreeObject} group the core bone; orbits are built around its origin */
		function addCoreParticles(group) {
			const list = [];
			for (let n = 0; n < 2000; n++) {
				const angle = random() * TAU,
					r =
						(0.11 + Math.pow(random(), 0.65) * 0.28) *
						(1 + 0.1 * Math.sin(angle * 5 + (n % 3))),
					lane = n % 3;
				const p = new THREE.Vector3(
					Math.cos(angle) * r,
					Math.sin(angle) * r * 0.68,
					gaussian() * 0.018,
				);
				p.applyAxisAngle(
					new THREE.Vector3(1, 0, 0),
					/** @type {number} */ ([0.45, -0.65, 1.2][lane]),
				);
				p.applyAxisAngle(new THREE.Vector3(0, 0, 1), lane * 0.75);
				list.push([p.x, p.y, p.z]);
			}
			const swarm = makePoints(list, palettes.gold, null, 0.95, 1);
			swarm.material.vertexShader = swarm.material.vertexShader.replace(
				"vec3 p=deform(position);",
				"vec3 q=position;float a=uFlow*.23*(.7+fract(aPhase)*.6),c=cos(a),s=sin(a);q.xz=mat2(c,-s,s,c)*q.xz;vec3 p=deform(q);",
			);
			group.add(swarm);
			group.userData.coreParticles = 2000;
			for (let lane = 0; lane < 3; lane++) {
				const points = [];
				for (let j = 0; j <= 120; j++) {
					const a = (j / 120) * TAU,
						r = (0.21 + lane * 0.048) * (1 + 0.11 * Math.sin(a * 3 + lane)),
						p = new THREE.Vector3(Math.cos(a) * r, Math.sin(a) * r * 0.66, 0);
					p.applyAxisAngle(
						new THREE.Vector3(1, 0, 0),
						/** @type {number} */ ([0.45, -0.65, 1.2][lane]),
					);
					p.applyAxisAngle(new THREE.Vector3(0, 0, 1), lane * 0.75);
					points.push(p);
				}
				group.add(
					new THREE.Line(
						own(new THREE.BufferGeometry()).setFromPoints(points),
						lineMaterial(palettes.gold, 0.1, false),
					),
				);
			}
		}
		/** @type {Record<string, any>} */
		const models = { b: makeFlame("b") };
		for (const [id, m] of Object.entries(models)) {
			m.visible = id === "b";
			root.add(m);
		}
		// A soft plane beneath the avatar anchors its 3D volume without introducing another illustration.
		const floor = new THREE.Mesh(
			own(new THREE.PlaneGeometry(5, 5)),
			own(
				new THREE.ShaderMaterial({
					uniforms: { uColor: { value: palettes.gold } },
					transparent: true,
					depthWrite: false,
					blending: THREE.AdditiveBlending,
					side: THREE.DoubleSide,
					vertexShader: `varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
					fragmentShader: `uniform vec3 uColor;varying vec2 vUv;void main(){float r=length(vUv-.5)*2.;float a=exp(-r*r*18.)*.13+pow(max(0.,1.-abs(r-.43)*20.),2.)*.045;gl_FragColor=vec4(uColor,a);}`,
				}),
			),
		);
		floor.rotation.x = -Math.PI / 2;
		floor.position.y = -1.96;
		scene.add(floor);
		// Lightweight bloom: local half-resolution buffers, two blur passes, no addon dependency.
		const base = own(
				new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType }),
			),
			ping = own(new THREE.WebGLRenderTarget(1, 1)),
			pong = own(new THREE.WebGLRenderTarget(1, 1));
		const quadScene = new THREE.Scene(),
			quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1),
			quad = new THREE.Mesh(own(new THREE.PlaneGeometry(2, 2)));
		quadScene.add(quad);
		const blurUniforms = {
			uTexture: { value: /** @type {THREE.Texture | null} */ (null) },
			uDirection: { value: new THREE.Vector2(1, 0) },
			uThreshold: { value: 0 },
		};
		const blur = own(
			new THREE.ShaderMaterial({
				uniforms: blurUniforms,
				vertexShader: `varying vec2 vUv;void main(){vUv=uv;gl_Position=vec4(position.xy,0.,1.);}`,
				fragmentShader: `uniform sampler2D uTexture;uniform vec2 uDirection;uniform float uThreshold;varying vec2 vUv;vec3 read(vec2 uv){vec3 c=texture2D(uTexture,uv).rgb;return max(vec3(0.),c-vec3(uThreshold));}void main(){vec3 c=read(vUv)*.227027;c+=read(vUv+uDirection*1.384615)*.316216;c+=read(vUv-uDirection*1.384615)*.316216;c+=read(vUv+uDirection*3.230769)*.07027;c+=read(vUv-uDirection*3.230769)*.07027;gl_FragColor=vec4(c,1.);}`,
			}),
		);
		const combine = own(
			new THREE.ShaderMaterial({
				uniforms: {
					uBase: { value: base.texture },
					uGlow: { value: pong.texture },
				},
				vertexShader: `varying vec2 vUv;void main(){vUv=uv;gl_Position=vec4(position.xy,0.,1.);}`,
				fragmentShader:
					`uniform sampler2D uBase;uniform sampler2D uGlow;varying vec2 vUv;void main(){vec3 c=texture2D(uBase,vUv).rgb+texture2D(uGlow,vUv).rgb*.65;gl_FragColor=vec4(c,1.);#include <tonemapping_fragment>\n#include <colorspace_fragment>\n gl_FragColor.a=clamp(max(texture2D(uBase,vUv).a,max(gl_FragColor.r,max(gl_FragColor.g,gl_FragColor.b))),0.,1.);}`.replace(
						";#include",
						";\n#include",
					),
			}),
		);
		let yaw = 0,
			pitch = 0,
			w = 1,
			h = 1;
		function resize() {
			w = Math.max(1, host.clientWidth);
			h = Math.max(1, host.clientHeight);
			renderer.setSize(w, h, false);
			camera.aspect = w / h;
			camera.position.z = camera.aspect < 0.65 ? 9.5 : 8.5;
			camera.updateProjectionMatrix();
			const d = renderer.getPixelRatio();
			base.setSize(Math.round(w * d), Math.round(h * d));
			ping.setSize(Math.round((w * d) / 2), Math.round((h * d) / 2));
			pong.setSize(Math.round((w * d) / 2), Math.round((h * d) / 2));
		}
		const performer = createPerformer();
		const secondary = createSecondaryMotion(skeleton);
		const flame = models.b;
		let layers = { ...defaultLayers },
			/** @type {import("./clips.ts").Pose} */
			pose = {},
			/** @type {string | null} */
			activeMode = null,
			flow = 0,
			lastTime = 0,
			frontFacing = 1;
		/** @type {THREE.SkeletonHelper | null} */
		let skeletonHelper = null;
		// Arm tips leave a short fading light trail; one draw call for all four arms.
		const trailLength = 8;
		const trailPositions = new Float32Array(
			flame.userData.arms.length * trailLength * 3,
		);
		const trailGeometry = own(new THREE.BufferGeometry());
		trailGeometry.setAttribute(
			"position",
			new THREE.BufferAttribute(trailPositions, 3).setUsage(
				THREE.DynamicDrawUsage,
			),
		);
		const trailAlpha = new Float32Array(
			flame.userData.arms.length * trailLength,
		);
		trailGeometry.setAttribute(
			"aAlpha",
			new THREE.BufferAttribute(trailAlpha, 1).setUsage(THREE.DynamicDrawUsage),
		);
		const trailMaterial = own(
			new THREE.ShaderMaterial({
				uniforms: {
					uColor: { value: palettes.gold },
					uPixelRatio: { value: renderer.getPixelRatio() },
				},
				transparent: true,
				depthWrite: false,
				blending: THREE.AdditiveBlending,
				vertexShader: `uniform float uPixelRatio;attribute float aAlpha;varying float vAlpha;void main(){vAlpha=aAlpha;vec4 mv=modelViewMatrix*vec4(position,1.);gl_Position=projectionMatrix*mv;gl_PointSize=(.35+aAlpha)*18.*uPixelRatio*(6.5/-mv.z);}`,
				fragmentShader: `uniform vec3 uColor;varying float vAlpha;void main(){vec2 p=gl_PointCoord-.5;float d=dot(p,p);if(d>.25)discard;gl_FragColor=vec4(uColor,exp(-d*18.)*vAlpha*.6);}`,
			}),
		);
		const trail = new THREE.Points(trailGeometry, trailMaterial);
		trail.frustumCulled = false;
		scene.add(trail);
		let trailReady = false;
		const tipWorld = new THREE.Vector3(),
			scratch = new THREE.Vector3(),
			eyesWorld = new THREE.Vector3(),
			eyesForward = new THREE.Vector3(),
			eyesQuaternion = new THREE.Quaternion();
		let trailTime = 0;
		/**
		 * Shifts each tip's history once per advance of the clock (a redraw at the same time
		 * keeps it) and hides samples that sit on the tip: no motion, no trail.
		 * @param {number} time
		 */
		function updateTrail(time) {
			if (time < trailTime) trailReady = false;
			const advance = !trailReady || time > trailTime;
			trailTime = time;
			flame.userData.arms.forEach(
				(/** @type {any} */ arm, /** @type {number} */ a) => {
					arm.bone.getWorldPosition(tipWorld);
					const base = a * trailLength * 3;
					if (!trailReady)
						for (let i = 0; i < trailLength; i++)
							tipWorld.toArray(trailPositions, base + i * 3);
					if (advance)
						trailPositions.copyWithin(
							base + 3,
							base,
							base + (trailLength - 1) * 3,
						);
					tipWorld.toArray(trailPositions, base);
					for (let i = 0; i < trailLength; i++) {
						const distance = scratch
							.fromArray(trailPositions, base + i * 3)
							.distanceTo(tipWorld);
						trailAlpha[a * trailLength + i] =
							(1 - i / trailLength) *
							THREE.MathUtils.smoothstep(distance, 0.04, 0.22);
					}
				},
			);
			trailReady = true;
			trailGeometry.getAttribute("position").needsUpdate = true;
			trailGeometry.getAttribute("aAlpha").needsUpdate = true;
		}
		/** @param {string} name */
		const c = (name) => pose[name] ?? 0;
		/**
		 * @param {number} [time]
		 * @param {string} [mode]
		 * @param {number} [elapsed]
		 * @param {boolean} [speaking]
		 */
		function render(time = 0, mode = "neutral", elapsed = 0, speaking = false) {
			renderer.info.reset();
			const dt = Math.min(0.25, Math.max(0, time - lastTime));
			lastTime = time;
			activeMode = mode;
			pose = performer.sample(time, mode, elapsed, speaking, layers);
			uniforms.uTime.value = time;
			uniforms.uEnergy.value = Math.max(0, c("light.energy"));
			uniforms.uSparkle.value = Math.max(0, c("light.sparkle"));
			flow += dt * (1 + Math.max(0, c("light.swirl")) * 2.5);
			uniforms.uFlow.value = flow;
			root.position.set(c("body.px"), c("body.py"), c("body.pz"));
			root.rotation.set(
				pitch + c("body.x"),
				yaw + 0.34 + c("body.y") + c("spin"),
				c("body.z"),
			);
			skeleton.reset();
			for (const bone of skeleton.ordered) {
				const x = pose[`${bone.name}.x`],
					y = pose[`${bone.name}.y`],
					z = pose[`${bone.name}.z`];
				if (x || y || z) bone.rotation.set(x ?? 0, y ?? 0, z ?? 0);
			}
			const open = clamp(1 - c("eyes.close"), 0.025, 1);
			for (const eye of flame.userData.eyes) {
				eye.position
					.copy(eye.userData.rest)
					.add(scratch.set(c("eyes.gx"), c("eyes.gy"), 0));
				eye.scale.set(
					eye.userData.isGlow ? 0.125 : 1,
					eye.userData.isGlow ? open * 0.128 : open,
					eye.userData.isGlow ? 0.16 : 1,
				);
			}
			const energy = uniforms.uEnergy.value,
				core = Math.max(-0.6, c("light.core"));
			flame.userData.core.scale.setScalar(
				0.6 * (1 + energy * 0.08 + core * 0.5),
			);
			flame.userData.star.scale.setScalar(1 + core * 0.45);
			root.updateMatrixWorld(true);
			if (layers.secondary) secondary.update(time);
			else secondary.reset();
			skeleton.upload(flame);
			flame.userData.eyes[0].parent.getWorldPosition(eyesWorld);
			flame.userData.eyes[0].parent.getWorldQuaternion(eyesQuaternion);
			eyesForward.set(0, 0, 1).applyQuaternion(eyesQuaternion);
			frontFacing = eyesForward.dot(
				scratch.copy(camera.position).sub(eyesWorld).normalize(),
			);
			for (const eye of flame.userData.eyes) eye.visible = frontFacing > 0.06;
			updateTrail(time);
			renderer.setRenderTarget(base);
			renderer.render(scene, camera);
			quad.material = blur;
			blurUniforms.uTexture.value = base.texture;
			blurUniforms.uDirection.value.set(2.2 / ping.width, 0);
			blurUniforms.uThreshold.value = 0.24;
			renderer.setRenderTarget(ping);
			renderer.render(quadScene, quadCamera);
			blurUniforms.uTexture.value = ping.texture;
			blurUniforms.uDirection.value.set(0, 2.2 / pong.height);
			blurUniforms.uThreshold.value = 0;
			renderer.setRenderTarget(pong);
			renderer.render(quadScene, quadCamera);
			quad.material = combine;
			renderer.setRenderTarget(null);
			renderer.render(quadScene, quadCamera);
		}
		const hitTest = createAvatarHitTest(renderer, camera, bone);
		resize();
		render();
		return {
			canvas: renderer.domElement,
			resize,
			render,
			/** @param {import("./performer.ts").MotionChoice} [choice] */
			beginMotion(choice) {
				performer.begin(choice);
				trailReady = false;
			},
			/** @param {string} variant */
			react(variant) {
				return performer.react(variant);
			},
			hitTest,
			/** @param {Partial<import("./performer.ts").AvatarLayers>} next */
			setLayers(next) {
				layers = { ...layers, ...next };
			},
			/** @param {boolean} visible */
			showSkeleton(visible) {
				if (visible && !skeletonHelper) {
					skeletonHelper = new THREE.SkeletonHelper(skeleton.root);
					own(skeletonHelper.geometry);
					own(skeletonHelper.material);
					scene.add(skeletonHelper);
				} else if (!visible && skeletonHelper) {
					scene.remove(skeletonHelper);
					release(skeletonHelper.geometry);
					release(skeletonHelper.material);
					skeletonHelper = null;
				}
			},
			stats() {
				const playing = performer.current();
				return {
					time: Number(uniforms.uTime.value.toFixed(3)),
					motion: activeMode,
					variant: playing.variant,
					variantLabel: playing.label,
					boneCount: boneNames.length,
					armCount: flame.userData.arms.length,
					coreParticles: flame.userData.coreParticles || 0,
					headNod: Number(c("head.x").toFixed(3)),
					headTurn: Number(c("head.y").toFixed(3)),
					headTilt: Number(c("head.z").toFixed(3)),
					spin: Number(c("spin").toFixed(3)),
					lift: Number(c("body.py").toFixed(3)),
					eyeOpen: Number(clamp(1 - c("eyes.close"), 0, 1).toFixed(3)),
					eyesVisible: frontFacing > 0.06,
					frontFacing: Number(frontFacing.toFixed(3)),
					renderer: "Three.js WebGL",
					revision: THREE.REVISION,
					geometries: renderer.info.memory.geometries,
					drawCalls: renderer.info.render.calls,
					points: renderer.info.render.points,
					triangles: renderer.info.render.triangles,
				};
			},
			dispose,
		};
	} catch (error) {
		dispose();
		throw error;
	}
}
