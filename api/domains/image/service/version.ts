import { sha256Hex } from "../../../infrastructure/digest";

/** Fixes the storage connection and the returned original bytes at generation time. */
export function generatedImageVersion(
	binding: string,
	bytes: Uint8Array,
): string {
	return `${binding}:${sha256Hex(bytes)}`;
}
