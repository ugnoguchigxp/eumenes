import { resultSchema, type ResearchResult } from "../contracts";
import type { Acquisition } from "../adapters/llm-fetch";
import type { createSavedBodies } from "./saved-bodies";
export function boundResult(result: ResearchResult): ResearchResult {
	const parsed = resultSchema.parse(result);
	const documents = parsed.documents.map((doc) => ({ ...doc, text: "" }));
	let rawRemaining = 24000;
	let encodedRemaining =
		32 * 1024 - Buffer.byteLength(JSON.stringify({ ...parsed, documents }));
	if (encodedRemaining < 0) throw new Error("web_result_too_large");
	for (let i = 0; i < documents.length; i++) {
		const original = parsed.documents[i]!;
		const chunks: string[] = [];
		for (const character of original.text) {
			const bytes = Buffer.byteLength(character),
				encoded = Buffer.byteLength(JSON.stringify(character)) - 2;
			if (bytes > rawRemaining || encoded > encodedRemaining) break;
			chunks.push(character);
			rawRemaining -= bytes;
			encodedRemaining -= encoded;
		}
		const text = chunks.join("");
		documents[i] = {
			...original,
			text,
			truncated: original.truncated || text !== original.text,
		};
	}
	return { ...parsed, documents };
}

export function createDeliveryBuffer(
	bodies: ReturnType<typeof createSavedBodies>,
	now: () => number,
) {
	const results = new Map<
		string,
		{ value: ResearchResult; savedUrls: string[]; expires: number }
	>();
	function prune() {
		for (const [key, value] of results)
			if (value.expires <= now()) {
				results.delete(key);
				bodies.forgetDelivery(key);
			}
		while (results.size > 64) {
			const first = results.keys().next().value!;
			results.delete(first);
			bodies.forgetDelivery(first);
		}
	}
	return {
		prune,
		close: () => results.clear(),
		remember(runId: string, value: Acquisition) {
			const publicResult = boundResult(value.result);
			const savedUrls = publicResult.documents
				.filter((d) => bodies.deliveryText(runId, d.url) !== undefined)
				.map((d) => d.url);
			results.set(runId, {
				value: {
					...publicResult,
					documents: publicResult.documents.map((d) =>
						savedUrls.includes(d.url) ? { ...d, text: "" } : d,
					),
				},
				savedUrls,
				expires: now() + 15 * 60000,
			});
			prune();
		},
		get(runId: string): ResearchResult | null {
			const result = results.get(runId);
			if (!result) return null;
			if (
				result.savedUrls.some(
					(url) => bodies.deliveryText(runId, url) === undefined,
				)
			)
				return null;
			return boundResult({
				...result.value,
				documents: result.value.documents.map((d) =>
					result.savedUrls.includes(d.url)
						? {
								...d,
								text: (bodies.deliveryText(runId, d.url) ?? "")
									.slice(0, 12000)
									.replace(/[\uD800-\uDBFF]$/u, ""),
							}
						: d,
				),
			});
		},
	};
}
