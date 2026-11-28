import { createHmac } from "node:crypto";
import {
	TOKEN_ESTIMATE,
	estimateJsonTokens,
	estimateMessageTokens,
	estimateTextTokens,
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
		"Summary",
		"Earlier",
		"Agency",
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

/** The fields of `## State` the host writes (a line that ends a field's name with `:`), by a fixed word each. */
const STATE_FIELDS: readonly (readonly [prefix: string, label: string])[] = [
	["今:", "now"],
	["仕事:", "work"],
	["提示中:", "presented"],
	["共有中:", "shared"],
	["予定:", "plans"],
	["目標:", "goals"],
	["受領した生成画像:", "media"],
	["あなた自身の関心・問い", "interests"],
];
const AGENCY_STATE = /^<あなたの今の状態[^>]*>(.*)<\/あなたの今の状態>$/su;

/**
 * The parts of the input's last message (what changes with every call): its `## ` sections, the fields of
 * `## State`, and the top-level keys of the agency's state. Role `part`, a fixed label (`State.work`,
 * `Agency.notes`, a key of the state's own JSON), estimated tokens and a short hash; never text. Empty when the last
 * message has none of the product's headings.
 */
export function tailSections(messages: Messages): InputSection[] {
	const last = messages.at(-1);
	if (!last || last.role !== "user") return [];
	const parts: InputSection[] = [];
	const add = (label: string, text: string) => {
		if (text)
			parts.push({
				role: "part",
				label,
				tokens: estimateTextTokens(text),
				hash: hash(text),
			});
	};
	let heading: string | null = null;
	let body: string[] = [];
	const close = () => {
		if (heading === null) return;
		if (heading === "State") {
			let field = "other";
			let lines: string[] = [];
			const flush = () => {
				add(`State.${field}`, lines.join("\n"));
				lines = [];
			};
			for (const line of body) {
				const named = STATE_FIELDS.find(([prefix]) => line.startsWith(prefix));
				if (named) {
					flush();
					field = named[1];
				}
				lines.push(line);
			}
			flush();
		} else if (heading === "Agency") {
			const text = body.join("\n").trim();
			let state: unknown;
			try {
				state = JSON.parse(AGENCY_STATE.exec(text)?.[1] ?? "");
			} catch {
				state = null;
			}
			if (state && typeof state === "object" && !Array.isArray(state))
				for (const [key, value] of Object.entries(state))
					// A key of the package's own state, never a name a user wrote.
					add(
						`Agency.${/^[A-Za-z][A-Za-z0-9]{0,40}$/.test(key) ? key : "other"}`,
						JSON.stringify(value),
					);
			else add("Agency", text);
		} else add(heading, body.join("\n"));
		body = [];
	};
	for (const line of last.content.split("\n")) {
		const known = HEADINGS.get(line.trimEnd());
		if (known) {
			close();
			heading = known;
		} else if (heading !== null) body.push(line);
	}
	close();
	return parts;
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
