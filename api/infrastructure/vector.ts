import { sha256Hex } from "./digest";

/** The vector space a stored embedding belongs to (the shape every domain that stores vectors shares). */
export type VectorSpaceShape = {
	modelId: string;
	revision: string;
	artifactDigest: string;
	dimension: number;
};

/** Stable key of a vector space; vectors of different spaces are never compared. */
export function vectorSpaceKey(space: VectorSpaceShape): string {
	return sha256Hex(
		JSON.stringify([
			space.modelId,
			space.revision,
			space.artifactDigest,
			space.dimension,
		]),
	).slice(0, 32);
}
/** Float32 values, in the platform's (little endian) byte order, as a blob. */
export function packVector(values: number[]): Uint8Array {
	return new Uint8Array(new Float32Array(values).buffer);
}
export function unpackVector(blob: Uint8Array): Float32Array {
	const copy = new Uint8Array(blob);
	return new Float32Array(copy.buffer, 0, copy.byteLength / 4);
}
export function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
	let sum = 0;
	for (let i = 0; i < a.length; i++) sum += a[i]! * b[i]!;
	return sum;
}
