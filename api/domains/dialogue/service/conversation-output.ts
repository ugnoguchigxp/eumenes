import type { NativeTool } from "../../../infrastructure/chat-stream";
import { getLogger } from "../../../infrastructure/logger";

const log = getLogger("dialogue");

/**
 * Check control syntax only. Never interpret or execute an operation from text: control syntax written in the answer
 * (a call written as text, a provider delimiter) is never published or kept, and the answer ends before it.
 */
export function conversationOutput(
	publish: (text: string) => void,
	tools: NativeTool[],
) {
	const names = [...new Set(tools.map((t) => t.function.name))];
	const escaped = names.map((name) =>
		name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
	);
	// A call written as text: `name({` or `name {"key` / `name {key`. A tool name in ordinary speech is not one.
	const callSyntax = new RegExp(
		`(?:${escaped.join("|")})\\s*(?:\\(\\s*\\{|\\{\\s*["\\w])`,
	);
	const callStart = new RegExp(
		`(?:${escaped.join("|")})\\s*(?:\\(\\s*)?\\{?\\s*$`,
	);
	// An offered tool written as an XML tag: `<delegate>`, `<work\n` (run `a3c89c6e`). The full-width brackets are
	// the same tag: the log draws past text with them, and the model copies them back (run `6c08b000`).
	const tagSyntax = new RegExp(`[<＜]/?(?:${escaped.join("|")})[\\s>＞]`);
	const tags = names.flatMap((name) => [`<${name}`, `＜${name}`]);
	// These are provider control delimiters, not ordinary answer text (`<tool_call>` / `<function=`: run `f4764696`).
	const delimiters = [
		"<|",
		"<call:",
		"<tool_call>",
		"<function",
		"<parameter",
	].flatMap((token) => [token, `＜${token.slice(1).replace(">", "＞")}`]);
	const prefixes = [...names, ...tags, ...delimiters].flatMap((word) =>
		Array.from({ length: word.length }, (_, i) => word.slice(0, i + 1)),
	);
	let pending = "",
		published = "",
		blocked = false,
		characters = 0;
	const send = (text: string) => {
		if (!text) return;
		published += text;
		publish(text);
	};
	/** Where the first control syntax of `text` starts; -1 when it has none. */
	function controlStart(text: string) {
		const starts = [
			...delimiters.map((token) => text.indexOf(token)),
			text.search(callSyntax),
			text.search(tagSyntax),
		].filter((at) => at >= 0);
		return starts.length ? Math.min(...starts) : -1;
	}
	function tail(text: string) {
		let held = 0;
		for (const prefix of prefixes)
			if (text.endsWith(prefix)) held = Math.max(held, prefix.length);
		// Hold a complete function name, and its opening bracket, until what follows shows whether it is a call.
		const opened = text.match(callStart);
		if (opened) held = Math.max(held, opened[0].length);
		return held;
	}
	/** Control syntax and everything after it is dropped: the text before it is the answer. */
	function block(text: string, at: number) {
		blocked = true;
		pending = "";
		send(text.slice(0, at).trimEnd());
		log.warn("dialogue.control_text_dropped", {
			reason: "control_text_in_body",
		});
	}
	return {
		delta(text: string) {
			characters += text.length;
			if (characters > 65536) throw new Error("chat_output_too_large");
			if (blocked) return;
			pending += text;
			const at = controlStart(pending);
			if (at >= 0) return block(pending, at);
			const end = pending.length - tail(pending);
			if (end) send(pending.slice(0, end));
			pending = pending.slice(end);
		},
		/** Ends the output; returns the answer, which is exactly what was published. */
		finish(text: string): string {
			if (!blocked) {
				// A response that did not stream (or streamed less) is checked whole.
				const whole = published + pending;
				const rest = text.startsWith(whole) ? text : whole;
				const at = controlStart(rest);
				if (at >= 0)
					block(
						rest.slice(published.length),
						Math.max(0, at - published.length),
					);
				else send(rest.slice(published.length));
			}
			pending = "";
			return published;
		},
	};
}
