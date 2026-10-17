/**
 * The candidate arms of the experiment "how a source is shown" (evaluation design section 6.1). Every arm renders
 * the same product `ContextAssembly`; only the surface differs.
 *
 * - A1 tag: every block but the history in `<context source="...">`; the frame sentences stay as they are.
 * - A2 tag+rules: A1 plus the attributes `authority`, `freshness`, `certainty`, `covers`; the handling rules are one
 *   table in the system part and each frame is one line.
 * - A3 markdown: a `## label` heading per block instead of the tag; `#` in data is escaped.
 * - A4 json: every block is a JSON envelope `{"source", "authority", "frame", "data"}`.
 * - A5 tag+rules/user-role: A2 with the reference blocks in the user role (so they sit behind the history: the
 *   transcript split of the agent SDK takes the first non-system messages for the history).
 *
 * The history is native-role in every arm. The surface differs from the `current` format in three more shared ways
 * (design section 6.1): every host rule stays in the system part as it is, the operation and research results are
 * enveloped blocks (not bare user JSON), and a drawing result is placed like the other results. A failed research
 * answer keeps the current assembly in every arm. All user- and external-derived strings go through
 * `referenceJson`. The prose of the arms lives in system-context tomls (context-eval/arm-*.context.toml).
 */
import { systemContext } from "../../../../api/infrastructure/system-context";
import {
	type ContextBlock,
	referenceJson,
} from "../../../../api/domains/inference";
import {
	type ArmOutput,
	type ContextArm,
	baselineArm,
} from "../../../../api/domains/dialogue/eval/context/arm";
import { splitRecallText } from "../../../../api/domains/dialogue/eval/context/recall-text";
import { parseRecallBlock } from "../../../../api/domains/memory";
import type { ChatMessage } from "../../../../api/domains/dialogue/service/context";
import type { ContextAssembly } from "../../../../api/domains/dialogue/service/context-assembly";
import { renderContext } from "../../../../api/domains/dialogue/service/context-render";

type Style = "tag" | "markdown" | "json";
type Variant = {
	style: Style;
	/** Attributes on the envelope and one-line frames (the rules are in the system part). */
	rules: boolean;
	/** Reference blocks are user-role messages. */
	userReference: boolean;
};

/** `key | text` lines (a line that starts no key continues the previous text). */
function parseTable(text: string): Map<string, string> {
	const table = new Map<string, string>();
	let key: string | undefined;
	for (const line of text.split("\n")) {
		const match = /^([a-z0-9._]+) \| (.*)$/.exec(line);
		if (match) {
			key = match[1]!;
			table.set(key, match[2]!);
		} else if (key) table.set(key, `${table.get(key)}\n${line}`);
	}
	return table;
}
let frameTable: Map<string, string> | undefined;
const frames = () =>
	(frameTable ??= parseTable(
		systemContext("dialogue.contexts.context-eval.arm-frames", {}),
	));

/** The key each operation result travels under: the one the host rules name (`imageResult`, ...). */
const OPERATION_KEYS: Record<string, string> = {
	"operation.action": "actionResult",
	"operation.recognition": "recognitionResult",
	"operation.delegation": "delegationResult",
	"operation.drawing": "drawingResult",
	"operation.image": "imageResult",
	"operation.music": "musicResult",
	"operation.command_question": "commandQuestion",
	"specialist.work": "specialistWork",
	"specialist.viewing": "viewing",
	"specialist.handoff": "specialistHandoff",
};

/** `s` as the inside of a JSON string: `<`, `>`, `&`, quotes, backslashes and line breaks cannot forge a delimiter. */
const escapeLine = (s: string) => referenceJson(s).slice(1, -1);
/** Multi-line text keeps its line breaks; every line is escaped on its own. */
const escapeText = (text: string, markdown: boolean) =>
	text
		.split("\n")
		.map((line) => {
			const escaped = escapeLine(line);
			return markdown ? escaped.replace(/#/g, "\\#") : escaped;
		})
		.join("\n");

/** The data of a block that has an own JSON form: `{key: value}` for results and records, the value otherwise. */
function jsonData(block: ContextBlock): unknown {
	if (block.body.kind === "json") {
		const key = OPERATION_KEYS[block.source];
		return key ? { [key]: block.body.value } : block.body.value;
	}
	if (block.body.kind === "text" && block.source === "specialist.handoff")
		return { specialistHandoff: block.body.text };
	return undefined;
}

/** The frame sentence of a block in a variant, or undefined when it has none. */
function frameOf(block: ContextBlock, v: Variant): string | undefined {
	if (v.rules) return frames().get(`a2.${block.source}`);
	if (block.body.kind === "lines" && block.body.header)
		return block.body.header;
	return frames().get(`a1.${block.source}`);
}

/** The data lines of a block for the tag and markdown styles (already escaped). */
function dataLines(block: ContextBlock, v: Variant): string[] {
	const markdown = v.style === "markdown";
	const { body } = block;
	if (body.kind === "lines") {
		return body.sections.flatMap((section) => [
			...(section.heading === undefined
				? []
				: [
						`${markdown ? "### " : "## "}${escapeText(section.heading, markdown)}`,
					]),
			...section.items.map((item) => escapeText(item, markdown)),
		]);
	}
	const json = jsonData(block);
	if (json !== undefined) return [referenceJson(json)];
	if (body.kind === "text") {
		if (block.source === "memory.recall") {
			const entries = parseRecallBlock(body.text);
			// Rules variants show the entries only; the others keep the text memory wrote (frame and delimiters).
			if (v.rules && entries) return [referenceJson(entries)];
			if (!v.rules) return [body.text];
		}
		return [escapeText(body.text, markdown)];
	}
	return [referenceJson(body.value)];
}

function attributes(block: ContextBlock): string {
	const parts = [
		`authority="${block.authority}"`,
		`freshness="${block.freshness}"`,
	];
	if (block.certainty) parts.push(`certainty="${block.certainty}"`);
	if (block.covers?.fromAt) parts.push(`covers_from="${block.covers.fromAt}"`);
	if (block.covers?.toAt) parts.push(`covers_to="${block.covers.toAt}"`);
	if (block.covers?.turns !== undefined)
		parts.push(`covers_turns="${block.covers.turns}"`);
	return parts.join(" ");
}

const label = (source: string) => frames().get(`label.${source}`) ?? source;

/** The JSON envelope of a block (A4). */
function jsonEnvelope(block: ContextBlock): string {
	const frame = frameOf(block, {
		style: "json",
		rules: false,
		userReference: false,
	});
	const { body } = block;
	const json = jsonData(block);
	let data: unknown;
	if (body.kind === "lines")
		data = body.sections.map((section) => ({
			...(section.heading === undefined ? {} : { heading: section.heading }),
			items: section.items,
		}));
	else if (json !== undefined) data = json;
	else if (body.kind === "text")
		data =
			block.source === "memory.recall"
				? (splitRecallText(body.text)?.entries ?? body.text)
				: body.text;
	else data = body.value;
	return referenceJson({
		source: block.source,
		authority: block.authority,
		...(frame === undefined ? {} : { frame }),
		data,
	});
}

/** The message text of one block. */
function renderBlockText(block: ContextBlock, v: Variant): string {
	if (v.style === "json") return jsonEnvelope(block);
	const frame = frameOf(block, v);
	const lines = [
		...(frame === undefined ? [] : [frame]),
		...dataLines(block, v),
	];
	if (v.style === "markdown")
		return [`## ${label(block.source)}`, ...lines].join("\n");
	const open = `<context source="${block.source}"${v.rules ? ` ${attributes(block)}` : ""}>`;
	return [open, ...lines, "</context>"].join("\n");
}

const TAG_WRAPPED =
	/^<context source="[a-z_.]+"( [a-z_]+="[^"]*")*>\n[\s\S]*\n<\/context>$/;
const MARKDOWN_WRAPPED = /^## \S/;
function jsonWrapped(content: string): boolean {
	try {
		const value = JSON.parse(content) as Record<string, unknown>;
		return (
			typeof value.source === "string" &&
			typeof value.authority === "string" &&
			"data" in value
		);
	} catch {
		return false;
	}
}
const matches = (text: string, pattern: RegExp) =>
	[...text.matchAll(pattern)].map((m) => m[1]!);
const TAG_SOURCE = /<context source=\\?"([a-z_.]+)\\?"/g;
const JSON_SOURCE = /\\?"source\\?":\\?"([a-z_.]+)\\?"/g;
function markdownSources(text: string): string[] {
	const found: string[] = [];
	for (const [key, value] of frames())
		if (key.startsWith("label.") && text.includes(`## ${value}`))
			found.push(key.slice("label.".length));
	return found;
}

const turnMessage = (
	turn: ContextAssembly["history"]["turns"][number],
): ChatMessage => ({
	role: turn.role,
	content: turn.content,
	...(turn.attachments?.length
		? { attachments: turn.attachments, sourceMessageId: turn.sourceMessageId }
		: {}),
});

/** The system part of the current format (persona and every host rule), plus what the variant adds to it. */
function systemPart(assembly: ContextAssembly, v: Variant): string {
	const base = renderContext(assembly, "current").messages[0]!.content;
	if (!v.rules) return base;
	const table = systemContext(
		"dialogue.contexts.context-eval.arm-rule-table",
		{},
	);
	const note = v.userReference
		? `\n${systemContext("dialogue.contexts.context-eval.arm-role-note", {})}`
		: "";
	return `${base}\n${table}${note}`;
}

function build(assembly: ContextAssembly, v: Variant): ArmOutput {
	// A failed research answer is the same in every arm (the current assembly): it drops the layers on purpose.
	if (assembly.volatile.some((b) => b.source === "research.failure"))
		return baselineArm.build(assembly);
	const role = (block: ContextBlock): "system" | "user" =>
		v.userReference && block.authority === "reference" ? "user" : "system";
	const message = (block: ContextBlock): ChatMessage => ({
		role: role(block),
		content: renderBlockText(block, v),
	});
	const kept = assembly.history.turns.filter((t) => t.layer === "keep");
	const unprocessed = assembly.history.turns.filter(
		(t) => t.layer === "unprocessed",
	);
	const system: ChatMessage = {
		role: "system",
		content: systemPart(assembly, v),
	};
	// With reference blocks as user messages the history must come first: the transcript split takes the first
	// non-system messages after the instructions as the history.
	const messages: ChatMessage[] = v.userReference
		? [
				system,
				...kept.map(turnMessage),
				...unprocessed.map(turnMessage),
				...assembly.stable.map(message),
				...assembly.working.map(message),
				...assembly.volatile.map(message),
			]
		: [
				system,
				...assembly.stable.map(message),
				...kept.map(turnMessage),
				...assembly.working.map(message),
				...unprocessed.map(turnMessage),
				...assembly.volatile.map(message),
			];
	messages.push(assembly.input);
	return {
		messages,
		sessionContext: {
			instructionCount: v.userReference ? 1 : 1 + assembly.stable.length,
			historyCount: assembly.history.turns.length,
		},
		currentRequestIndex: messages.length - 1,
	};
}

const armOf = (
	id: string,
	v: Variant,
	wrapped: ContextArm["wrapped"],
	sourcesIn: ContextArm["sourcesIn"],
): ContextArm => ({ id, wrapped, sourcesIn, build: (a) => build(a, v) });

const tag = (text: string) => matches(text, TAG_SOURCE);

export const arms: ContextArm[] = [
	armOf(
		"A1",
		{ style: "tag", rules: false, userReference: false },
		(c) => TAG_WRAPPED.test(c),
		tag,
	),
	armOf(
		"A2",
		{ style: "tag", rules: true, userReference: false },
		(c) => TAG_WRAPPED.test(c),
		tag,
	),
	armOf(
		"A3",
		{ style: "markdown", rules: false, userReference: false },
		(c) => MARKDOWN_WRAPPED.test(c),
		markdownSources,
	),
	armOf(
		"A4",
		{ style: "json", rules: false, userReference: false },
		jsonWrapped,
		(t) => matches(t, JSON_SOURCE),
	),
	armOf(
		"A5",
		{ style: "tag", rules: true, userReference: true },
		(c) => TAG_WRAPPED.test(c),
		tag,
	),
];
