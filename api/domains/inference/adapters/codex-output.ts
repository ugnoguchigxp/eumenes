/** Require a successful turn before accepting the explicit final-response file.
 * Progress and reasoning events are never interpreted as host operations. */
export function codexControlMessage(output: string, final: string) {
	let completed = 0;
	for (const line of output.split("\n").filter((line) => line.trim())) {
		let event;
		try {
			event = JSON.parse(line);
		} catch {
			throw new Error("codex_research_invalid_output");
		}
		if (!event || typeof event !== "object" || typeof event.type !== "string")
			throw new Error("codex_research_invalid_output");
		if (event.type === "turn.failed" || event.type === "error")
			throw new Error("codex_research_failed");
		if (event.type === "turn.completed") completed++;
	}
	if (completed !== 1) throw new Error("codex_research_incomplete_turn");
	if (!final.trim()) throw new Error("codex_research_empty_output");
	return final.trim();
}
