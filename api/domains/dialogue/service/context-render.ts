import type { RenderedContext } from "../../inference";
import type { ChatMessage } from "./context";
import type { ContextAssembly } from "./context-assembly";
import { renderCurrent } from "./context-format-current";

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
			return renderCurrent(assembly);
	}
}
