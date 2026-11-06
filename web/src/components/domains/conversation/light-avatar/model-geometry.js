// @ts-check
import * as THREE from "three";
import { setInfluences, torsoInfluence } from "./skeleton.ts";
/** @typedef {any} ThreeObject */
const TAU = Math.PI * 2;
const clamp = THREE.MathUtils.clamp;
/** @param {<T>(resource: T) => T} own */
export function createAvatarGeometry(own) {
	/** @type {Record<string, [number, number, number, number][]>} */
	const profiles = {
		b: [
			[0, -1.96, 0, 0.008],
			[0.12, -1.48, 0, 0.09],
			[0.26, -0.89, 0, 0.17],
			[0.4, -0.24, 0, 0.22],
			[0.52, 0.25, 0, 0.265],
			[0.6, 0.61, 0, 0.145],
			[0.65, 0.82, 0, 0.21],
			[0.72, 1.08, 0, 0.48],
			[0.8, 1.4, 0, 0.61],
			[0.87, 1.68, 0, 0.53],
			[0.92, 1.81, -0.055, 0.38],
			[0.946, 1.9, -0.17, 0.21],
			[0.965, 1.995, -0.285, 0.1],
			[0.98, 2.095, -0.29, 0.047],
			[0.992, 2.15, -0.22, 0.021],
			[1, 2.14, -0.15, 0.003],
		],
	};
	/**
	 * @param {number} u
	 * @param {string} kind
	 * @returns {[number, number, number]}
	 */
	function profile(u, kind) {
		const p = /** @type {[number, number, number, number][]} */ (
			profiles[kind]
		);
		/** @param {number} row @returns {[number, number, number, number]} */
		const at = (row) =>
			/** @type {[number, number, number, number]} */ (p[row]);
		let i = 0;
		while (i < p.length - 2 && u > at(i + 1)[0]) i++;
		const a = at(i),
			b = at(i + 1),
			t = clamp((u - a[0]) / (b[0] - a[0]), 0, 1);
		const smooth = t * t * (3 - 2 * t);
		if (kind === "b") {
			const prev = at(Math.max(0, i - 1)),
				next = at(Math.min(p.length - 1, i + 2)),
				span = b[0] - a[0];
			/** @param {1 | 2 | 3} column */
			const hermite = (column) => {
				const ma = (b[column] - prev[column]) / (b[0] - prev[0]),
					mb = (next[column] - a[column]) / (next[0] - a[0]);
				return (
					(2 * t * t * t - 3 * t * t + 1) * a[column] +
					(t * t * t - 2 * t * t + t) * span * ma +
					(-2 * t * t * t + 3 * t * t) * b[column] +
					(t * t * t - t * t) * span * mb
				);
			};
			return [hermite(1), hermite(2), Math.max(0.001, hermite(3))];
		}
		return [
			THREE.MathUtils.lerp(a[1], b[1], t),
			THREE.MathUtils.lerp(a[2], b[2], smooth),
			THREE.MathUtils.lerp(a[3], b[3], smooth),
		];
	}
	/**
	 * @param {number} u
	 * @param {number} phi
	 */
	const shellPoint = (u, phi, kind = "b", scale = 1) => {
		const [y, cx, r] = profile(u, kind),
			fold = 1 + 0.008 * Math.cos(phi * 4);
		return new THREE.Vector3(
			cx + Math.cos(phi) * r * scale * fold,
			y,
			Math.sin(phi) * r * scale * 0.94 * fold,
		);
	};

	/** @param {THREE.BufferGeometry} geo Torso parts follow the bones by height. */
	const byHeight = (geo) => {
		const position = geo.getAttribute("position");
		return setInfluences(
			geo,
			Array.from({ length: position.count }, (_, i) =>
				torsoInfluence(position.getY(i)),
			),
		);
	};
	/** @param {number[][]} list */
	const heightInfluences = (list) =>
		list.map((p) => torsoInfluence(/** @type {number} */ (p[1])));
	/** @param {string} kind */
	function shellGeometry(kind) {
		const positions = [],
			uvs = [],
			indices = [],
			rows = 72,
			cols = 48;
		for (let i = 0; i <= rows; i++)
			for (let j = 0; j <= cols; j++) {
				const t = i / rows,
					u =
						kind === "b"
							? t < 0.72
								? (t / 0.72) * 0.87
								: 0.87 + ((t - 0.72) / 0.28) * 0.13
							: t,
					p = shellPoint(u, (j / cols) * TAU, kind);
				positions.push(p.x, p.y, p.z);
				uvs.push(j / cols, u);
			}
		for (let i = 0; i < rows; i++)
			for (let j = 0; j < cols; j++) {
				const k = i * (cols + 1) + j;
				indices.push(k, k + cols + 1, k + 1, k + 1, k + cols + 1, k + cols + 2);
			}
		const geo = own(new THREE.BufferGeometry());
		geo.setAttribute(
			"position",
			new THREE.Float32BufferAttribute(positions, 3),
		);
		geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
		geo.setIndex(indices);
		geo.computeVertexNormals();
		return byHeight(geo);
	}

	/**
	 * @param {ThreeObject} curve
	 * @param {number} width
	 */
	function ribbonGeometry(curve, width, twist = 0, rootWidth = 0) {
		const positions = [],
			uvs = [],
			indices = [],
			rows = 72,
			cols = 8;
		for (let j = 0; j <= rows; j++) {
			const u = j / rows,
				p = curve.getPoint(u),
				t = curve.getTangent(u);
			const side = new THREE.Vector3(
				-t.y,
				t.x,
				Math.sin(u * 8) * 0.45,
			).normalize();
			side.applyAxisAngle(t, twist * Math.sin(u * Math.PI));
			const normal = new THREE.Vector3().crossVectors(t, side).normalize();
			const r =
				width *
				(Math.pow(Math.sin(Math.PI * u), 0.7) + rootWidth * Math.pow(1 - u, 3));
			for (let k = 0; k <= cols; k++) {
				const v = (k / cols) * 2 - 1,
					q = p
						.clone()
						.addScaledVector(side, r * v)
						.addScaledVector(normal, Math.cos((v * Math.PI) / 2) * r * 0.42);
				positions.push(q.x, q.y, q.z);
				uvs.push(k / cols, u);
			}
		}
		for (let j = 0; j < rows; j++)
			for (let k = 0; k < cols; k++) {
				const i = j * (cols + 1) + k;
				indices.push(i, i + cols + 1, i + 1, i + 1, i + cols + 1, i + cols + 2);
			}
		const geo = own(new THREE.BufferGeometry());
		geo.setAttribute(
			"position",
			new THREE.Float32BufferAttribute(positions, 3),
		);
		geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
		geo.setIndex(indices);
		geo.computeVertexNormals();
		return geo;
	}
	return {
		profile,
		shellPoint,
		byHeight,
		heightInfluences,
		shellGeometry,
		ribbonGeometry,
	};
}
