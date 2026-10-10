/**
 * The submit arguments a web tool call becomes. The agent's tool arguments are validated
 * by the tool schema; the web domain adds the fixed parts of each operation.
 * Throws `capability_unavailable` for a tool this domain does not run.
 */
export function webToolArguments(
	toolId: string,
	args: Record<string, unknown>,
	requestId: string,
): Record<string, unknown> {
	if (toolId !== "web.lookup" && toolId !== "web.read")
		throw new Error("capability_unavailable");
	return {
		...args,
		requestId,
		freshness: "live",
		...(toolId === "web.lookup"
			? { operation: "lookup", readPages: 0 }
			: { operation: "read", retention: "none" }),
	};
}
