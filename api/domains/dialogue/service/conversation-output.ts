import type { NativeTool } from "../../../infrastructure/chat-stream";
import { ValidationFailure } from "../../../infrastructure/validation-log";

/** Check control syntax only. Never interpret or execute an operation from text. */
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
	// An offered tool written as an XML tag: `<delegate>`, `<work\n` (run `a3c89c6e`).
	const tagSyntax = new RegExp(`</?(?:${escaped.join("|")})[\\s>]`);
	const tags = names.map((name) => `<${name}`);
	// These are provider control delimiters, not ordinary answer text (`<tool_call>` / `<function=`: run `f4764696`).
	const delimiters = ["<|", "<call:", "<tool_call>", "<function", "<parameter"];
	const prefixes = [...names, ...tags, ...delimiters].flatMap((word) =>
		Array.from({ length: word.length }, (_, i) => word.slice(0, i + 1)),
	);
	let pending = "",
		blocked = false,
		characters = 0;
	const invalid = (text: string) =>
		delimiters.some((token) => text.includes(token)) ||
		callSyntax.test(text) ||
		tagSyntax.test(text);
	function tail(text: string) {
		let held = 0;
		for (const prefix of prefixes)
			if (text.endsWith(prefix)) held = Math.max(held, prefix.length);
		// Hold a complete function name, and its opening bracket, until what follows shows whether it is a call.
		const opened = text.match(callStart);
		if (opened) held = Math.max(held, opened[0].length);
		return held;
	}
	return {
		delta(text: string) {
			characters += text.length;
			if (characters > 65536) throw new Error("chat_output_too_large");
			if (blocked) return;
			pending += text;
			if (invalid(pending)) {
				blocked = true;
				pending = "";
				return;
			}
			const end = pending.length - tail(pending);
			if (end) publish(pending.slice(0, end));
			pending = pending.slice(end);
		},
		finish(text: string) {
			if (blocked || invalid(text))
				throw new ValidationFailure("control_text_in_body", [
					{ reason: "control_text_in_body" },
				]);
			if (pending) publish(pending);
			pending = "";
		},
	};
}
