import { systemContext } from "../../../infrastructure/system-context";
import type {
	ContextBlock,
	ContextLines,
	ContextSource,
	RenderedContext,
} from "../../inference";
import type {
	ContextAssembly,
	HistoryTurn,
	HostRuleId,
} from "./context-assembly";
import type { ChatMessage } from "./context";
import { researchResultContext } from "./research-result-context";
import { buildSystemPrompt } from "./system-prompt";
import type { OperationSource } from "./context-blocks";

/**
 * The `current` format: the layout, the frame sentences and the host's rules as the conversation has always
 * shown them to the model. The content (`ContextAssembly`) knows none of this.
 */

const SUMMARY_FRAME = systemContext(
	"dialogue.contexts.context-compiler.summary-frame",
	{},
);
const WORK_FRAME = systemContext(
	"dialogue.contexts.generation-prepare.specialist-work",
	{},
);
const VIEWING_FRAME = systemContext(
	"dialogue.contexts.generation-prepare.specialist-viewing",
	{},
);
const HANDOFF_FRAME = systemContext(
	"dialogue.contexts.generation-prepare.specialist-handoff",
	{},
);
const NOTICE_FRAME =
	"記憶の担当からの連絡です。必要なら会話の中で一言伝えてください。";

/** The operations in the order their results have always been added, each with the key its result travels under. */
const OPERATIONS: ReadonlyArray<{ source: OperationSource; key: string }> = [
	{ source: "operation.action", key: "actionResult" },
	{ source: "operation.recognition", key: "recognitionResult" },
	{ source: "operation.delegation", key: "delegationResult" },
	{ source: "operation.drawing", key: "drawingResult" },
	{ source: "operation.image", key: "imageResult" },
	{ source: "operation.music", key: "musicResult" },
	{ source: "operation.command_question", key: "commandQuestion" },
];

/** The text of each host rule: it says when it applies, so the system part carries all of them on every turn. */
const RULE_TEXT: Record<HostRuleId, string> = {
	no_functions: systemContext("dialogue.contexts.host-rules.no-functions", {}),
	operation_action: systemContext(
		"dialogue.contexts.host-rules.operation-action",
		{},
	),
	operation_recognition: systemContext(
		"dialogue.contexts.host-rules.operation-recognition",
		{},
	),
	operation_delegation: systemContext(
		"dialogue.contexts.host-rules.operation-delegation",
		{},
	),
	operation_drawing: systemContext(
		"dialogue.contexts.host-rules.operation-drawing",
		{},
	),
	operation_image: systemContext(
		"dialogue.contexts.host-rules.operation-image",
		{},
	),
	operation_music: systemContext(
		"dialogue.contexts.host-rules.operation-music",
		{},
	),
	operation_command_question: systemContext(
		"dialogue.contexts.host-rules.operation-command-question",
		{},
	),
	research_result: systemContext(
		"dialogue.contexts.host-rules.research-result",
		{},
	),
	research_world: systemContext(
		"dialogue.contexts.host-rules.research-world",
		{},
	),
	research_document: systemContext(
		"dialogue.contexts.host-rules.research-document",
		{},
	),
};

/** The user message that carries an operation's result: a JSON document with the one key of that operation. */
export function operationResultMessage(
	source: OperationSource,
	value: unknown,
): ChatMessage {
	const operation = OPERATIONS.find((o) => o.source === source)!;
	return { role: "user", content: JSON.stringify({ [operation.key]: value }) };
}

/** Lines as a layer text: the header, then each section (the long-term layer puts a blank line before a heading). */
function linesText(body: ContextLines, gapBeforeHeading: boolean) {
	const lines = body.header === undefined ? [] : [body.header];
	for (const section of body.sections) {
		if (section.heading !== undefined) {
			if (gapBeforeHeading) lines.push("");
			lines.push(section.heading);
		}
		lines.push(...section.items);
	}
	return lines.join("\n");
}

const system = (content: string): ChatMessage => ({ role: "system", content });

/** The message of one block that is not an operation result or a research result. */
function blockMessage(block: ContextBlock): ChatMessage {
	const { body } = block;
	switch (block.source) {
		case "memory.long_term":
			if (body.kind !== "lines") throw new Error("context_block_body");
			return system(linesText(body, true));
		case "goals":
		case "memory.short_term":
			return system(
				body.kind === "lines"
					? linesText(body, false)
					: body.kind === "text"
						? body.text
						: JSON.stringify(body.value),
			);
		case "memory.summary":
			if (body.kind !== "text") throw new Error("context_block_body");
			return system(`${SUMMARY_FRAME}\nこれまでの経緯（要約）\n${body.text}`);
		case "memory.notice":
			if (body.kind !== "lines") throw new Error("context_block_body");
			return system(`${NOTICE_FRAME}\n${linesText(body, false)}`);
		case "memory.recall":
		case "world.names":
			if (body.kind !== "text") throw new Error("context_block_body");
			return system(body.text);
		case "specialist.work":
			if (body.kind !== "json") throw new Error("context_block_body");
			return system(
				`${WORK_FRAME}\nspecialistWork=${JSON.stringify(body.value)}`,
			);
		case "specialist.viewing":
			if (body.kind !== "json") throw new Error("context_block_body");
			return system(`${VIEWING_FRAME}\nviewing=${JSON.stringify(body.value)}`);
		case "specialist.handoff":
			if (body.kind !== "text") throw new Error("context_block_body");
			return system(`${HANDOFF_FRAME}\nspecialistHandoff=${body.text}`);
		default:
			throw new Error(`context_block_source:${block.source}`);
	}
}

function turnMessage(turn: HistoryTurn): ChatMessage {
	return {
		role: turn.role,
		content: turn.content,
		...(turn.attachments?.length
			? { attachments: turn.attachments, sourceMessageId: turn.sourceMessageId }
			: {}),
	};
}

/** The layers of the context as messages, in the order the list shows them. */
type Layers = {
	system: ChatMessage;
	longTerm: ChatMessage[];
	goals: ChatMessage[];
	/** The exchanges kept verbatim. */
	history: ChatMessage[];
	/** The summary, then the short-term notes. */
	working: ChatMessage[];
	/** Exchanges no memory step has taken out of the prompt yet. */
	unprocessed: ChatMessage[];
	input: ChatMessage;
};

/** The system part (S): the persona and the host's rules, the same on every turn of a conversation. */
export function systemMessageOf(a: ContextAssembly): ChatMessage {
	return system(
		buildSystemPrompt(a.persona) +
			a.hostRules.map((id) => "\n" + RULE_TEXT[id]).join(""),
	);
}

/** The messages of the layers by part, and the message of every volatile block that has one of its own. */
function layout(a: ContextAssembly) {
	const sections: Layers = {
		system: systemMessageOf(a),
		longTerm: a.stable
			.filter((b) => b.source === "memory.long_term")
			.map(blockMessage),
		goals: a.stable.filter((b) => b.source === "goals").map(blockMessage),
		history: a.history.turns.filter((t) => t.layer === "keep").map(turnMessage),
		working: a.working.map(blockMessage),
		unprocessed: a.history.turns
			.filter((t) => t.layer === "unprocessed")
			.map(turnMessage),
		input: a.input,
	};
	const volatile = new Map<ContextBlock, ChatMessage>();
	for (const block of a.volatile) {
		if (
			block.source === "research.result" ||
			block.source === "research.failure" ||
			block.source.startsWith("operation.")
		)
			continue;
		volatile.set(block, blockMessage(block));
	}
	return { sections, volatile };
}

/** The list of an answer to a failed research: it drops the layers and carries the failure (see `researchResultContext`). */
function failureList(sections: Layers, block: ContextBlock) {
	if (block.body.kind !== "json") throw new Error("context_block_body");
	const failure = block.body.value as {
		failureCode: string;
		projection: string | undefined;
		nowMs: number;
	};
	return researchResultContext(
		sections,
		failure.projection,
		failure.failureCode,
		failure.nowMs,
	);
}

/** Render the assembly as the message list the conversation sends. */
export function renderCurrent(
	a: ContextAssembly,
): RenderedContext<ChatMessage> {
	const { sections, volatile } = layout(a);
	const failure = a.volatile.find((b) => b.source === "research.failure");
	const result = a.volatile.find((b) => b.source === "research.result");
	const reportMessage = (block: ContextBlock): ChatMessage => {
		if (block.body.kind !== "json") throw new Error("context_block_body");
		return { role: "user", content: JSON.stringify(block.body.value) };
	};
	// A failed research answer keeps its own context apart from the layers; the report of a successful one is
	// volatile data like the operation results, after them.
	const report = result ? reportMessage(result) : undefined;
	const messages: ChatMessage[] = failure
		? failureList(sections, failure)
		: [
				sections.system,
				...sections.longTerm,
				...sections.goals,
				...sections.history,
				...sections.working,
				...sections.unprocessed,
				sections.input,
			];
	// Before the input: what the layers' text decided, then the operation results. A drawing result is added
	// after the input, and the operation results that come after it in this order land between them.
	const before: ChatMessage[] = [...volatile.values()];
	const between: ChatMessage[] = [];
	let drawing: ChatMessage | undefined;
	const blockMessages = new Map<ContextSource, ChatMessage>();
	for (const operation of OPERATIONS) {
		const block = a.volatile.find((b) => b.source === operation.source);
		if (!block) continue;
		if (block.body.kind !== "json") throw new Error("context_block_body");
		const message = operationResultMessage(operation.source, block.body.value);
		blockMessages.set(operation.source, message);
		if (operation.source === "operation.drawing") drawing = message;
		else (drawing ? between : before).push(message);
	}
	for (const [block, message] of volatile)
		blockMessages.set(block.source, message);
	if (report) before.push(report);
	messages.splice(messages.length - 1, 0, ...before);
	messages.push(...between, ...(drawing ? [drawing] : []));

	const instructions = new Set([...sections.longTerm, ...sections.goals]);
	let instructionCount = 1;
	while (instructions.has(messages[instructionCount]!)) instructionCount++;
	const history = new Set([...sections.history, ...sections.unprocessed]);
	const historyAt = messages.flatMap((m, i) => (history.has(m) ? [i] : []));
	return {
		messages,
		sessionContext: { instructionCount, historyCount: historyAt.length },
		currentRequestIndex: messages.indexOf(sections.input),
		cacheBreakpoints: [
			{ id: "B1" as const, index: 0 },
			...(instructionCount > 1
				? [{ id: "B2" as const, index: instructionCount - 1 }]
				: []),
			...(historyAt.length
				? [{ id: "B3" as const, index: historyAt[historyAt.length - 1]! }]
				: []),
		],
		blockIndex: Object.fromEntries(
			[
				...blockMessages,
				...(report && result ? [[result.source, report] as const] : []),
			].map(([source, message]) => [source, messages.indexOf(message)]),
		),
	};
}
