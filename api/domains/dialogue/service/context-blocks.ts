import type { ContextBlock } from "../../inference";

/** Text a part of the host wrote as one piece (the World names hint, a handoff record). */
export function hostTextBlock(
	source: "world.names" | "specialist.handoff",
	text: string,
): ContextBlock {
	return {
		source,
		authority: source === "world.names" ? "reference" : "host_record",
		freshness: "this_turn",
		body: { kind: "text", text },
	};
}

/** A record the host keeps about a specialist session: the data only. */
export function specialistBlock(
	source: "specialist.work" | "specialist.viewing",
	value: unknown,
): ContextBlock {
	return {
		source,
		authority: "host_record",
		freshness: "this_turn",
		certainty: "host_confirmed",
		body: { kind: "json", value },
	};
}
