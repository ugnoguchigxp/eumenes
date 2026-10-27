import type { NativeTool } from "../../../infrastructure/chat-stream";
import { getLogger } from "../../../infrastructure/logger";

const log = getLogger("dialogue");
/** A reply sharing this many characters, as they are, with a line of the system part copies it. */
const COPY_CHARS = 15;

/**
 * Whether a text copies the system part: it holds `COPY_CHARS` characters of one of its lines as they are. A reply
 * that did was copied again from the recent conversation until nothing else was said (the tool-call reliability
 * design, section 5.5); ordinary replies share no such run with the rules (none of 292 measured replies did).
 */
export function systemCopyCheck(system: string): (text: string) => boolean {
	const windows = new Set(
		system
			.split("\n")
			.filter((line) => !line.startsWith("## "))
			.map((line) => line.replace(/^- /, ""))
			.flatMap((line) =>
				Array.from(
					{ length: Math.max(0, line.length - COPY_CHARS + 1) },
					(_, i) => line.slice(i, i + COPY_CHARS),
				),
			),
	);
	return (text) => {
		for (let i = 0; i + COPY_CHARS <= text.length; i++)
			if (windows.has(text.slice(i, i + COPY_CHARS))) return true;
		return false;
	};
}

/** Printable ASCII other than a space: what a call written as text is made of. */
const ATTACHED = /[!-~]/;
const ATTACHED_RUN = /[!-~]+$/;

/**
 * Check control syntax only. Never interpret or execute an operation from text: control syntax written in the answer
 * (a call written as text, a provider delimiter) is never published or kept, and the answer ends before it. An answer
 * that copies the system part (`system`) is not an answer at all: the output fails with `system_text_copied`, so it
 * is neither spoken further nor kept in the conversation's input.
 */
export function conversationOutput(
	publish: (text: string) => void,
	tools: NativeTool[],
	system?: string,
) {
	const copies = system ? systemCopyCheck(system) : null;
	/** Where the copy check has looked up to (each window is checked once). */
	let checked = 0;
	const checkCopy = (text: string) => {
		if (!copies) return;
		const from = Math.max(0, checked - COPY_CHARS + 1);
		checked = text.length;
		if (copies(text.slice(from))) {
			log.warn("dialogue.control_text_dropped", {
				reason: "system_text_copied",
			});
			throw new Error("system_text_copied");
		}
	};
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
		// A run of ASCII without spaces may be the start of a call written as text (`create_music{question:<|`):
		// it is held until a space or other text ends it, so control syntax found later takes it along.
		let held = text.match(ATTACHED_RUN)?.[0].length ?? 0;
		for (const prefix of prefixes)
			if (text.endsWith(prefix)) held = Math.max(held, prefix.length);
		// Hold a complete function name, and its opening bracket, until what follows shows whether it is a call.
		const opened = text.match(callStart);
		if (opened) held = Math.max(held, opened[0].length);
		return held;
	}
	/** Control syntax, the ASCII run it is attached to, and everything after it is dropped: the text before is the answer. */
	function block(text: string, at: number) {
		blocked = true;
		pending = "";
		let start = at;
		while (start > 0 && ATTACHED.test(text[start - 1]!)) start--;
		send(text.slice(0, start).trimEnd());
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
			checkCopy(published + pending);
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
				checkCopy(rest);
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
