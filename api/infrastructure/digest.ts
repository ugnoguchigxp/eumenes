import { createHash } from "node:crypto";

export function sha256Hex(input: string | Uint8Array): string {
	return createHash("sha256").update(input).digest("hex");
}

export type CanonicalJsonOptions = {
	/** Drop object members whose value is `undefined` (otherwise they become `null`). */
	omitUndefined: boolean;
	/**
	 * Object key order.
	 * - "codeUnit": UTF-16 code unit order (`a < b`). Use this for new code.
	 * - "locale": `a.localeCompare(b)`. tasks 互換専用。新規利用禁止
	 *   (ロケール依存。tasks の既存 digest を変えないためだけに残す)。
	 */
	keyOrder: "codeUnit" | "locale";
	/**
	 * research-routes 互換: members are emitted through a plain JS object, so
	 * integer-like keys ("1", "10") come first in ascending numeric order.
	 */
	integerKeysFirst?: boolean;
};

/** Stable JSON for persisted digests. Output must stay bit-identical per option set. */
export function canonicalJson(
	value: unknown,
	opts: CanonicalJsonOptions,
): string {
	const compare =
		opts.keyOrder === "locale"
			? (a: string, b: string) => a.localeCompare(b)
			: (a: string, b: string) => (a < b ? -1 : 1);
	const walk = (v: unknown): string => {
		if (Array.isArray(v)) return `[${v.map(walk).join(",")}]`;
		if (v && typeof v === "object") {
			const entries = Object.entries(v as Record<string, unknown>);
			const kept = opts.omitUndefined
				? entries.filter(([, x]) => x !== undefined)
				: entries;
			kept.sort(([a], [b]) => compare(a, b));
			const ordered = opts.integerKeysFirst ? jsPropertyOrder(kept) : kept;
			return `{${ordered.map(([k, x]) => `${JSON.stringify(k)}:${walk(x)}`).join(",")}}`;
		}
		return JSON.stringify(v) ?? "null";
	};
	return walk(value);
}

const isArrayIndex = (k: string) =>
	/^(0|[1-9]\d*)$/.test(k) && Number(k) <= 4294967294;

/** Reorders entries the way a plain JS object enumerates them. */
function jsPropertyOrder<T>(entries: [string, T][]): [string, T][] {
	const indexes = entries
		.filter(([k]) => isArrayIndex(k))
		.sort(([a], [b]) => Number(a) - Number(b));
	return [...indexes, ...entries.filter(([k]) => !isArrayIndex(k))];
}
