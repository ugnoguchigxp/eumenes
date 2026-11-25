/** Validate only this domain's versioned source contracts, never the meaning of their text. */
export function staleAgencySources(
	refs: readonly string[],
	capabilities: () => readonly string[],
): string[] {
	// A catalog is needed only for capability references and is current for this check.
	let currentCapabilities: Set<string> | undefined;
	return refs.filter((ref) => {
		if (!ref.startsWith("capability:")) return false;
		currentCapabilities ??= new Set(capabilities());
		return !currentCapabilities.has(ref.slice("capability:".length));
	});
}
