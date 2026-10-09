/** Stable JSON for digests. Key order is sorted; undefined fields are omitted. */
export function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value && typeof value === "object")
		return `{${Object.entries(value as Record<string, unknown>)
			.filter(([, v]) => v !== undefined)
			.sort(([a], [b]) => (a < b ? -1 : 1))
			.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
			.join(",")}}`;
	return JSON.stringify(value) ?? "null";
}

export function digest(value: unknown): string {
	return new Bun.CryptoHasher("sha256").update(canonical(value)).digest("hex");
}

export const iso = (ms: number) => new Date(ms).toISOString();
