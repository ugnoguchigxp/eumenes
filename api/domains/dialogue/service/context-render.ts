import type { RenderedContext } from "../../inference";
import type { ChatMessage } from "./context";
import type { ContextAssembly } from "./context-assembly";
import { renderCurrent, systemMessageOf } from "./context-format-current";
import { getLogger } from "../../../infrastructure/logger";
import { estimateMessageTokens, estimateTextTokens } from "../../inference";

const log = getLogger("dialogue");

/** Estimates of the source parts; no text, references or digests leave the compiler. */
export function contextPartSizes(assembly: ContextAssembly) {
	const blocks = (items: readonly unknown[]) =>
		items.reduce<number>(
			(sum, block) => sum + estimateTextTokens(JSON.stringify(block)),
			0,
		);
	return {
		S: estimateTextTokens(systemMessageOf(assembly).content),
		P: blocks(assembly.stable),
		H: assembly.history.turns.length
			? estimateMessageTokens(assembly.history.turns)
			: 0,
		W: blocks(assembly.working),
		V: blocks(assembly.volatile),
		R: estimateMessageTokens([assembly.input]),
	};
}

/** The formats an assembly can be rendered in. */
export type ContextFormat = "current";

/**
 * The model-visible message list of an assembly in a format, with the session split, the position of the current
 * request and the cache marks the layout decided. The content of the assembly is the same in every format.
 */
export function renderContext(
	assembly: ContextAssembly,
	format: ContextFormat,
): RenderedContext<ChatMessage> {
	switch (format) {
		case "current":
			for (const [phase, count] of Object.entries(contextPartSizes(assembly)))
				log.debug("dialogue.context_part_measured", {
					phase,
					count,
					kind: "estimated_tokens",
				});
			return renderCurrent(assembly);
	}
}
