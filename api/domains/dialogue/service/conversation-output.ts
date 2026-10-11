import type { NativeTool } from "../../../infrastructure/chat-stream";
import {
	conversationToolNames,
	operationRejection,
} from "./conversation-tools";

/** Check control syntax only. Never interpret or execute an operation from text. */
export function conversationOutput(
	publish: (text: string) => void,
	tools: NativeTool[] = [],
) {
	const names = [
		...new Set([
			...conversationToolNames,
			...tools.map((t) => t.function.name),
		]),
	];
	const escaped = names.map((name) =>
		name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
	);
	const callSyntax = new RegExp(`(?:${escaped.join("|")})\\s*[({]`);
	// These are provider control delimiters, not ordinary answer text.
	const delimiters = ["<|", "<call:"];
	const prefixes = [...names, ...delimiters].flatMap((word) =>
		Array.from({ length: word.length }, (_, i) => word.slice(0, i + 1)),
	);
	let pending = "",
		blocked = false,
		characters = 0;
	const invalid = (text: string) =>
		delimiters.some((token) => text.includes(token)) || callSyntax.test(text);
	function tail(text: string) {
		let held = 0;
		for (const prefix of prefixes)
			if (text.endsWith(prefix)) held = Math.max(held, prefix.length);
		// Hold a complete function name even if its opening bracket arrives after whitespace.
		const trimmed = text.trimEnd();
		for (const name of names)
			if (trimmed.endsWith(name))
				held = Math.max(held, name.length + text.length - trimmed.length);
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
				throw operationRejection("control_text_in_body");
			if (pending) publish(pending);
			pending = "";
		},
	};
}
