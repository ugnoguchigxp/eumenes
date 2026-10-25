import { parseResourceUri } from "../../resources";

/**
 * A resource URI inside text: `eumenes://<kind>/<encoded id>` with an optional `?action=`. The model never reads
 * one (spec resource-uri-implementation-plan-2026-10-25.md section 2.3), so text shown to it goes through here.
 */
const URI_IN_TEXT =
	/eumenes:\/\/[A-Za-z0-9.-]+\/[A-Za-z0-9\-_.!~*'()%]+(?:\?action=[a-z]+)?/gi;

/** A trailing character that ends a sentence or a bracket rather than an id. */
const TRAILING = /[.)'!*~]+$/;

/** The text with each resource URI replaced by `replace(canonical uri)`; text without one is returned as it is. */
export function replaceResourceUris(
	text: string,
	replace: (uri: string) => string,
): string {
	return text.replace(URI_IN_TEXT, (match) => {
		let candidate = match;
		for (;;) {
			const parsed = parseResourceUri(candidate);
			if (parsed) return replace(parsed.uri) + match.slice(candidate.length);
			const trimmed = candidate.replace(TRAILING, "");
			if (trimmed === candidate || !trimmed) return match;
			candidate = trimmed;
		}
	});
}

/** The value with every resource URI in its strings replaced; objects and arrays are rebuilt, not changed. */
export function replaceResourceUrisIn(
	value: unknown,
	replace: (uri: string) => string,
): unknown {
	if (typeof value === "string") return replaceResourceUris(value, replace);
	if (Array.isArray(value))
		return value.map((item) => replaceResourceUrisIn(item, replace));
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => [
				key,
				replaceResourceUrisIn(item, replace),
			]),
		);
	return value;
}
