import { createHmac } from "node:crypto";
import {
	TOKEN_ESTIMATE,
	estimateJsonTokens,
	estimateMessageTokens,
} from "../../../infrastructure/context-budget";
import type { Messages } from "../contracts";

/**
 * The sections of one model input, for measuring where a provider's cached prefix breaks: a section is one
 * message, the tool definitions, or the output schema. Only the role, a label, an estimated token count and
 * a short keyed hash of the section's text leave this module; the text itself never does.
 */
export type InputSection = {
	role: string;
	label: string;
	tokens: number;
	hash: string;
};

const HASH_DIGITS = 12;
/**
 * The key of the hash: random per process, kept in memory only and never stored or logged. A short text (a one-line
 * utterance) could be found from a plain hash by trying candidates; without the key it cannot. Hashes are therefore
 * comparable only within one process (`bootId` of the log row).
 */
const HASH_KEY = crypto.getRandomValues(new Uint8Array(32));
/** Opening tags whose message is named by a fixed label (never by its text). */
const KNOWN_TAGS: readonly (readonly [prefix: string, label: string])[] = [
	["<あなたの今の状態", "agency-state"],
];
/**
 * The `## ` headings the product itself writes into a model input (the dialogue input text). Only these become a
 * label: any other heading line may be text a user or a tool wrote, so it is named by a fixed word.
 */
const HEADINGS: ReadonlyMap<string, string> = new Map(
	[
		"Memory",
		"Earlier",
		"State",
		"User",
		"Host notice",
		"Candidates",
		"Pending",
		"Retry",
		"Points",
		"Task",
	].map((name) => [`## ${name}`, name]),
);

function hash(text: string): string {
	return createHmac("sha256", HASH_KEY)
		.update(text)
		.digest("hex")
		.slice(0, HASH_DIGITS);
}

type Message = Messages[number];

function messageLabel(message: Message): string {
	const content = message.content;
	for (const [prefix, label] of KNOWN_TAGS)
		if (content.startsWith(prefix)) return label;
	const heading = HEADINGS.get(content.split("\n", 1)[0]!.trimEnd());
	if (heading) return heading;
	if (message.role === "tool") return "tool-result";
	if (message.tool_calls?.length) return "tool-calls";
	return message.role === "system" ? "system" : "text";
}

function messageSection(message: Message): InputSection {
	return {
		role: message.role,
		label: messageLabel(message),
		tokens:
			estimateMessageTokens([message]) - TOKEN_ESTIMATE.requestOverheadTokens,
		hash: hash(
			JSON.stringify([
				message.content,
				message.tool_calls ?? null,
				message.tool_call_id ?? null,
				message.images?.length ?? 0,
			]),
		),
	};
}

/**
 * The sections in the order the input is sent: the tool definitions and the output schema (when there are any)
 * come first, then the messages.
 */
export function inputSections(input: {
	messages: Messages;
	tools?: readonly unknown[];
	outputSchema?: unknown;
}): InputSection[] {
	const sections: InputSection[] = [];
	if (input.tools?.length)
		sections.push({
			role: "tools",
			label: "tools",
			tokens: estimateJsonTokens(input.tools),
			hash: hash(JSON.stringify(input.tools)),
		});
	if (input.outputSchema !== undefined && input.outputSchema !== null)
		sections.push({
			role: "schema",
			label: "schema",
			tokens: estimateJsonTokens(input.outputSchema),
			hash: hash(JSON.stringify(input.outputSchema)),
		});
	for (const message of input.messages) sections.push(messageSection(message));
	return sections;
}

/** `role:label:tokens:hash` joined by `|`: the form of the `sections` log field (labels hold neither character). */
export function encodeSections(sections: readonly InputSection[]): string {
	return sections
		.map((s) => `${s.role}:${s.label}:${s.tokens}:${s.hash}`)
		.join("|");
}

/** The inverse of `encodeSections`; an omission marker (`…+N`) and any malformed part are skipped. */
export function decodeSections(text: string): InputSection[] {
	const sections: InputSection[] = [];
	for (const part of text.split("|")) {
		const [role, label, tokens, digest] = part.split(":");
		const count = Number(tokens);
		if (!role || !label || !digest || !Number.isSafeInteger(count)) continue;
		sections.push({ role, label, tokens: count, hash: digest });
	}
	return sections;
}
