/**
 * Serialization lanes (evaluation design section 6.2): how an arm's messages reach the model.
 *
 * - `larm-messages`: the message list as the product sends it to LARM.
 * - `flattened`: through the Cloud agents adapter's `promptParts` (the leading system messages joined into one
 *   system text, the history split off by the render's session split, the rest of the turn serialized as one prompt),
 *   then sent to the same LARM destination as [system, history..., user prompt]. It measures whether a source stays
 *   readable on a path that removes message boundaries.
 */
import { promptParts } from "../../../inference/adapters/cloud-agents";
import type { ChatMessage } from "../../service/context";
import type { ContextAssembly } from "../../service/context-assembly";
import type { ArmOutput, ContextArm } from "./arm";
import type { Serialization } from "./raw";
import { historyIndexes } from "./render-invariants";

/** The messages a lane sends for an arm's output. */
export function serialize(
	serialization: Serialization,
	out: ArmOutput,
): { messages: ChatMessage[]; currentRequestIndex: number } {
	if (serialization === "larm-messages")
		return {
			messages: out.messages,
			currentRequestIndex: out.currentRequestIndex,
		};
	const parts = promptParts(out.messages, out.sessionContext);
	const messages: ChatMessage[] = [
		{ role: "system", content: parts.system },
		...parts.history.map((turn) => ({ role: turn.role, content: turn.content })),
		{ role: "user", content: parts.prompt },
	];
	return { messages, currentRequestIndex: messages.length - 1 };
}

/**
 * A flattened output keeps every block source readable: each source an arm's envelopes name in the original
 * non-history messages is still named in the flattened system text or prompt (extra names are allowed: the
 * current request may quote an envelope). Arms without `sourcesIn` have nothing to check.
 */
export function flattenedSourceIssues(
	arm: Pick<ContextArm, "sourcesIn">,
	assembly: ContextAssembly,
	out: ArmOutput,
): string[] {
	if (!arm.sourcesIn) return [];
	const skip = new Set([
		...(historyIndexes(assembly.history.turns, out.messages) ?? []),
		out.currentRequestIndex,
	]);
	const original = out.messages
		.filter((_, i) => !skip.has(i))
		.flatMap((m) => arm.sourcesIn!(m.content));
	const flat = serialize("flattened", out).messages;
	const flatSources = new Set(
		[flat[0]!, flat[flat.length - 1]!].flatMap((m) => arm.sourcesIn!(m.content)),
	);
	return [...new Set(original)]
		.filter((source) => !flatSources.has(source))
		.map((source) => `flattened_source_lost:${source}`);
}
