import { BoxGeometry, Mesh, MeshStandardMaterial, Group, Texture } from "three";
import { expect, test, vi } from "vitest";
import { disposeObject } from "./glb-scene";

test("disposeObject releases geometries, materials and their textures", () => {
	const geometry = new BoxGeometry();
	const map = new Texture();
	const normal = new Texture();
	const material = new MeshStandardMaterial({ map, normalMap: normal });
	const other = new MeshStandardMaterial();
	const spies = [geometry, map, normal, material, other].map((o) =>
		vi.spyOn(o, "dispose"),
	);
	const root = new Group();
	root.add(new Mesh(geometry, material), new Mesh(new BoxGeometry(), [other]));
	disposeObject(root);
	for (const spy of spies) expect(spy).toHaveBeenCalledTimes(1);
});
