import type { Source, ToolResult } from "../contracts";
export function resultSources(result: ToolResult): Source[] {
	return (
		result.readings ?? [
			...result.hits.map((h) => ({
				sourceId: crypto.randomUUID(),
				url: h.url,
				title: h.title,
				basis: "snippet" as const,
				fetchedAt: result.observedAt,
				truncated: true,
				body: h.snippet.replaceAll("\r\n", "\n"),
			})),
			...result.documents.map((d) => ({
				sourceId: crypto.randomUUID(),
				url: d.url,
				title: d.title,
				basis: "page" as const,
				fetchedAt: d.fetchedAt,
				truncated: d.truncated,
				body: d.text.replaceAll("\r\n", "\n"),
			})),
		]
	);
}
export function operationFingerprint(toolId: string, args: unknown) {
	function canonical(v: unknown): unknown {
		if (typeof v === "string")
			return toolId === "web.lookup"
				? v
						.normalize("NFKC")
						.toLowerCase()
						.replace(/[\s\u3000]+/g, " ")
						.trim()
				: v;
		if (Array.isArray(v)) return v.map(canonical);
		if (v && typeof v === "object")
			return Object.fromEntries(
				Object.entries(v)
					.sort(([a], [b]) => a.localeCompare(b))
					.map(([k, x]) => [k, canonical(x)]),
			);
		return v;
	}
	return new Bun.CryptoHasher("sha256")
		.update(JSON.stringify([toolId, canonical(args)]))
		.digest("hex");
}
