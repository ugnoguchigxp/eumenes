import { canonicalJson, sha256Hex } from "../../../infrastructure/digest";

/** Stable JSON for digests. Key order is sorted; undefined fields are omitted. */
export function canonical(value: unknown): string {
	return canonicalJson(value, { omitUndefined: true, keyOrder: "codeUnit" });
}

export function digest(value: unknown): string {
	return sha256Hex(canonical(value));
}

export const iso = (ms: number) => new Date(ms).toISOString();
