import {
	Group,
	IcosahedronGeometry,
	Mesh,
	MeshStandardMaterial,
	TorusGeometry,
} from "three";
import type { SpatialModel } from "../contracts";
import { healthColors } from "../options";

/** Temporary glyph, replaced through the registry when a Dots model is accepted. */
export function createPlaceholder(): SpatialModel {
	const object = new Group();
	const geometry = new IcosahedronGeometry(0.48, 1);
	const ringGeometry = new TorusGeometry(0.7, 0.018, 6, 48);
	const material = new MeshStandardMaterial({
		color: "#8191ac",
		roughness: 0.4,
	});
	const ringMaterial = new MeshStandardMaterial({ color: "#8191ac" });
	const mesh = new Mesh(geometry, material);
	const ring = new Mesh(ringGeometry, ringMaterial);
	object.add(mesh, ring);
	let disposed = false;
	const colors = healthColors;
	return {
		object,
		update(state, selected) {
			material.color.set(colors[state.health]);
			material.wireframe = state.health === "unknown";
			const old = state.stale && state.health !== "disconnected";
			material.transparent = old;
			material.opacity = old ? 0.45 : 1;
			ringMaterial.color.set(selected ? "#ffffff" : colors[state.health]);
			ring.scale.setScalar(selected ? 1.15 : 1);
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			geometry.dispose();
			ringGeometry.dispose();
			material.dispose();
			ringMaterial.dispose();
		},
	};
}
