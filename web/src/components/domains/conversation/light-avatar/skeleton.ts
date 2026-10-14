import * as THREE from "three";

/** Fixed bone names shared by the motion data and any future glTF clips. */
export const armBones = (["outer", "inner"] as const).flatMap((layer) =>
	(["l", "r"] as const).flatMap((side) =>
		(["01", "02", "03", "tip"] as const).map(
			(joint) => `arm_${layer}_${side}_${joint}` as const,
		),
	),
);
export const boneNames = [
	"hips",
	"tail_01",
	"tail_02",
	"tail_03",
	"spine",
	"core",
	"chest",
	"neck",
	"head",
	"crown_01",
	"crown_02",
	"crown_03",
	"eyes",
	...armBones,
] as const;
export type BoneName = (typeof boneNames)[number];

type Vec3 = [number, number, number];
/** Bind positions are in the flame group's space; every bind rotation is identity. */
const torso: [BoneName, BoneName | null, Vec3][] = [
	["hips", null, [0, -0.35, 0]],
	["tail_01", "hips", [0, -0.75, 0]],
	["tail_02", "tail_01", [0, -1.25, 0]],
	["tail_03", "tail_02", [0, -1.65, 0]],
	["spine", "hips", [0, 0.05, 0]],
	["core", "spine", [0, 0.06, 0.15]],
	["chest", "spine", [0, 0.4, 0]],
	["neck", "chest", [0, 0.6, 0]],
	["head", "neck", [0, 0.9, 0]],
	["crown_01", "head", [-0.055, 1.81, 0]],
	["crown_02", "crown_01", [-0.17, 1.9, 0]],
	["crown_03", "crown_02", [-0.285, 1.995, 0]],
	["eyes", "head", [0, 1.4, 0.57]],
];
/** Regions along y, lowest first: each bone moves what lies beyond its joint. */
const shellRegions: [BoneName, number][] = [
	["tail_03", -Infinity],
	["tail_02", -1.65],
	["tail_01", -1.25],
	["hips", -0.75],
	["spine", 0.05],
	["chest", 0.4],
	["neck", 0.6],
	["head", 0.9],
	["crown_01", 1.81],
	["crown_02", 1.9],
	["crown_03", 1.995],
];
export type Influence = { bones: [number, number]; weight: number };

/**
 * Two-bone linear blend: inside a region its owner moves the vertex fully; across a
 * boundary the weight eases over half the narrower neighbour so joints stay smooth.
 */
function regionInfluence(
	coordinate: number,
	regions: [number, number][],
	cap: number,
): Influence {
	let i = 0;
	while (i < regions.length - 1 && coordinate >= regions[i + 1]![1]) i++;
	const width = (k: number) =>
		k < 0 || k >= regions.length
			? Infinity
			: (regions[k + 1]?.[1] ?? Infinity) - regions[k]![1];
	const band = (a: number, b: number) =>
		Math.min(cap, 0.5 * Math.min(width(a), width(b)));
	const owner = regions[i]![0];
	const start = regions[i]![1];
	const end = regions[i + 1]?.[1] ?? Infinity;
	const ease = (t: number) => t * t * (3 - 2 * t);
	if (i > 0) {
		const h = band(i - 1, i);
		if (coordinate - start < h)
			return {
				bones: [regions[i - 1]![0], owner],
				weight: 0.5 + 0.5 * ease((coordinate - start) / h),
			};
	}
	if (i < regions.length - 1) {
		const h = band(i, i + 1);
		if (end - coordinate < h)
			return {
				bones: [owner, regions[i + 1]![0]],
				weight: 0.5 - 0.5 * ease((end - coordinate) / h),
			};
	}
	return { bones: [owner, owner], weight: 0 };
}
const index = (name: BoneName) => boneNames.indexOf(name);
const shellIndexed = shellRegions.map(
	([name, at]) => [index(name), at] as [number, number],
);
/** Shell, veil, strands, waist membranes and body particles follow the torso by height. */
export const torsoInfluence = (y: number) =>
	regionInfluence(y, shellIndexed, 0.15);
/** Arm ribbons, lines and dust follow the curve parameter u (0 = shoulder). */
export function armInfluence(
	layer: "outer" | "inner",
	side: -1 | 1,
	u: number,
): Influence {
	const s = side < 0 ? "l" : "r";
	return regionInfluence(
		u,
		[
			[index("chest"), -Infinity],
			[index(`arm_${layer}_${s}_01`), 0],
			[index(`arm_${layer}_${s}_02`), 1 / 3],
			[index(`arm_${layer}_${s}_03`), 2 / 3],
			[index(`arm_${layer}_${s}_tip`), 1],
		],
		0.12,
	);
}
/** Writes the per-vertex attributes the skinning shader reads. */
export function setInfluences(
	geometry: THREE.BufferGeometry,
	influences: Influence[],
) {
	geometry.setAttribute(
		"aSkinIndex",
		new THREE.Float32BufferAttribute(
			influences.flatMap((f) => f.bones),
			2,
		),
	);
	geometry.setAttribute(
		"aSkinWeight",
		new THREE.Float32BufferAttribute(
			influences.map((f) => f.weight),
			1,
		),
	);
	return geometry;
}
/** Linear blend skinning from a float texture (4 texels per bone matrix). */
export const skinningGLSL = `
uniform sampler2D uBoneTexture;
attribute vec2 aSkinIndex;attribute float aSkinWeight;
mat4 boneMatrix(float i){int x=int(i+.5)*4;return mat4(texelFetch(uBoneTexture,ivec2(x,0),0),texelFetch(uBoneTexture,ivec2(x+1,0),0),texelFetch(uBoneTexture,ivec2(x+2,0),0),texelFetch(uBoneTexture,ivec2(x+3,0),0));}
mat4 skinMatrix(){return boneMatrix(aSkinIndex.x)*(1.-aSkinWeight)+boneMatrix(aSkinIndex.y)*aSkinWeight;}
`;

export type ArmChain = {
	layer: "outer" | "inner";
	side: -1 | 1;
	/** Joint positions at u = 0, 1/3, 2/3 and 1 along the arm curve. */
	joints: [Vec3, Vec3, Vec3, Vec3];
};
export type Skeleton = ReturnType<typeof createSkeleton>;

export function createSkeleton(arms: ArmChain[]) {
	const bones = new Map<BoneName, THREE.Bone>();
	const bind = new Map<BoneName, THREE.Vector3>();
	const add = (name: BoneName, parent: BoneName | null, at: Vec3) => {
		const bone = new THREE.Bone();
		bone.name = name;
		const position = new THREE.Vector3(...at);
		bind.set(name, position);
		bone.position.copy(
			parent ? position.clone().sub(bind.get(parent)!) : position,
		);
		bone.userData.rest = bone.position.clone();
		if (parent) bones.get(parent)!.add(bone);
		bones.set(name, bone);
	};
	for (const [name, parent, at] of torso) add(name, parent, at);
	for (const arm of arms) {
		const s = arm.side < 0 ? "l" : "r";
		const names = (["01", "02", "03", "tip"] as const).map(
			(joint) => `arm_${arm.layer}_${s}_${joint}` as BoneName,
		);
		names.forEach((name, k) =>
			add(name, k ? names[k - 1]! : "chest", arm.joints[k]!),
		);
	}
	if (bones.size !== boneNames.length)
		throw new Error("光の精霊の骨格が不足しています");
	const ordered = boneNames.map((name) => bones.get(name)!);
	const data = new Float32Array(ordered.length * 16);
	const texture = new THREE.DataTexture(
		data,
		ordered.length * 4,
		1,
		THREE.RGBAFormat,
		THREE.FloatType,
	);
	texture.minFilter = texture.magFilter = THREE.NearestFilter;
	texture.needsUpdate = true;
	const inverseGroup = new THREE.Matrix4(),
		skin = new THREE.Matrix4(),
		unbind = new THREE.Matrix4();
	return {
		root: bones.get("hips")!,
		bones,
		ordered,
		texture,
		/** Bind-space position, for parenting rigid parts (eyes, core, tips) to a bone. */
		bindPosition: (name: BoneName) => bind.get(name)!.clone(),
		reset() {
			for (const bone of ordered) {
				bone.position.copy(bone.userData.rest);
				bone.quaternion.identity();
			}
		},
		/** Call after the group's world matrices are current. */
		upload(group: THREE.Object3D) {
			inverseGroup.copy(group.matrixWorld).invert();
			ordered.forEach((bone, i) => {
				const at = bind.get(boneNames[i]!)!;
				unbind.makeTranslation(-at.x, -at.y, -at.z);
				skin
					.multiplyMatrices(inverseGroup, bone.matrixWorld)
					.multiply(unbind)
					.toArray(data, i * 16);
			});
			texture.needsUpdate = true;
		},
	};
}
