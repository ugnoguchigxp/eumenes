import type { Receipt } from "../../inference";
import type {
	NativeTool,
	NativeToolCall,
} from "../../../infrastructure/chat-stream";
import { getLogger } from "../../../infrastructure/logger";
import type { ChatMessage } from "./context";
import { INPUT_HEADINGS } from "./input-text";
import { generationTools, parseCall, TOOL_NAMES } from "./generation-tools";
import { NO_CANDIDATES } from "./result-text";

const log = getLogger("dialogue");

/*
 * The local harness's turn (the conversation harness design, section 5.3): a silent decision (reply, or which tool
 * with which arguments), then the reply streamed once its head passes the host's checks. A decision or head that
 * fails a check is neither spoken nor kept; the turn is answered again on the cloud. The checks are fixed rules over
 * the text; nothing here asks a model to judge.
 */

/** The check a local answer failed; the only thing the log carries of it. */
export type LocalCheck =
	| "decision_unparsed"
	| "tool_unknown"
	| "tool_arguments_invalid"
	| "searched_not_handed"
	| "promise_without_call"
	| "previous_reply_copied"
	| "input_copied";

type Schema = Record<string, unknown>;
const isRecord = (value: unknown): value is Schema =>
	!!value && typeof value === "object" && !Array.isArray(value);

/** An object schema with no properties: it takes any object, which a strict schema cannot describe. */
const freeForm = (schema: unknown) =>
	isRecord(schema) &&
	schema.type === "object" &&
	!(isRecord(schema.properties) && Object.keys(schema.properties).length);

/**
 * A tool's parameter schema in the provider's strict form: every property required (an optional one may be null),
 * no other property allowed. A free-form object cannot be strict, so it is written as text (a JSON object) and read
 * back by `parseDecision`.
 */
function strictParameters(schema: unknown): Schema {
	if (!isRecord(schema)) return { type: "string" };
	if (freeForm(schema))
		return {
			type: "string",
			...(typeof schema.description === "string"
				? { description: `${schema.description}（JSONオブジェクトの文字列）` }
				: {}),
		};
	if (schema.type === "object" && isRecord(schema.properties)) {
		const required = new Set(
			Array.isArray(schema.required) ? (schema.required as string[]) : [],
		);
		return {
			type: "object",
			additionalProperties: false,
			required: Object.keys(schema.properties),
			properties: Object.fromEntries(
				Object.entries(schema.properties).map(([key, property]) => {
					const strict = strictParameters(property);
					return [
						key,
						required.has(key) ? strict : { anyOf: [strict, { type: "null" }] },
					];
				}),
			),
		};
	}
	if (schema.type === "array")
		return { ...schema, items: strictParameters(schema.items) };
	return { ...schema };
}

/** The properties of a tool's arguments that are free-form objects (written as text in the decision). */
function freeFormProperties(name: string): string[] {
	const tool = generationTools.find((t) => t.function.name === name);
	const properties = tool?.function.parameters.properties;
	return isRecord(properties)
		? Object.entries(properties)
				.filter(([, property]) => freeForm(property))
				.map(([key]) => key)
		: [];
}

type Property = { key: string; nullable?: true; fixed?: string };

/**
 * The shapes a call can take, from the validators' own discriminated forms (not the flat native parameters): a
 * field a shape does not use is not in it, so the model cannot fill it. `resolveUnsaved` of `delegate` is left out on
 * purpose: filled blindly it discards unsaved work, and the rare discard flow is not expressible in the decision
 * (a turn that needs it is answered on the cloud).
 */
const SHAPES: Record<string, Property[][]> = {
	[TOOL_NAMES.memory]: [
		[{ key: "operation", fixed: "read" }, { key: "query" }],
		[
			{ key: "operation", fixed: "request" },
			{ key: "kind" },
			{ key: "what" },
			{ key: "detail", nullable: true },
		],
	],
	[TOOL_NAMES.search]: [[{ key: "query" }]],
	[TOOL_NAMES.delegate]: [
		[
			{ key: "mode" },
			{ key: "toolchain" },
			{ key: "request" },
			{ key: "impact" },
			{ key: "announcement", nullable: true },
			{ key: "inputs", nullable: true },
			{ key: "target", nullable: true },
			{ key: "refs", nullable: true },
		],
		[
			{ key: "mode", fixed: "approve" },
			{ key: "confirmation" },
			{ key: "announcement", nullable: true },
		],
	],
	[TOOL_NAMES.work]: [
		[{ key: "todo" }, { key: "operation" }, { key: "text", nullable: true }],
	],
};
/** The modes of `delegate` the first shape takes (the native definition lists all three). */
const EXECUTING = ["execute", "confirm"];

/** One shape's arguments as a strict object; each field keeps the native definition's type and description. */
function shapeArguments(tool: NativeTool, shape: Property[]): Schema {
	const native = isRecord(tool.function.parameters.properties)
		? tool.function.parameters.properties
		: {};
	const fields = shape.map(({ key, fixed, nullable }): [string, Schema] => {
		const given = isRecord(native[key]) ? native[key] : {};
		const strict: Schema = fixed
			? { type: "string", enum: [fixed] }
			: key === "mode" && tool.function.name === TOOL_NAMES.delegate
				? { ...strictParameters(given), enum: EXECUTING }
				: strictParameters(given);
		if (!nullable) return [key, strict];
		const described =
			typeof strict.description === "string" ? strict.description : undefined;
		return [
			key,
			{
				anyOf: [
					{
						...strict,
						description: `${described ? `${described} ` : ""}使わないときは null`,
					},
					{ type: "null" },
				],
			},
		];
	});
	return {
		type: "object",
		additionalProperties: false,
		required: fields.map(([key]) => key),
		properties: Object.fromEntries(fields),
	};
}

/**
 * The decision as one strict JSON schema: `{ action: "reply" }`, or `{ action: "call", tool }` with one branch per
 * callable shape of the offered tools (its name fixed, its arguments in that shape's strict form). `call` cannot come
 * without a tool and `reply` cannot carry one.
 */
export function decisionSchema(tools: readonly NativeTool[]) {
	const branch = (properties: Schema) => ({
		type: "object",
		additionalProperties: false,
		required: Object.keys(properties),
		properties,
	});
	return {
		anyOf: [
			branch({ action: { type: "string", enum: ["reply"] } }),
			...tools.flatMap((tool) =>
				(SHAPES[tool.function.name] ?? []).map((shape) =>
					branch({
						action: { type: "string", enum: ["call"] },
						tool: branch({
							name: { type: "string", enum: [tool.function.name] },
							arguments: shapeArguments(tool, shape),
						}),
					}),
				),
			),
		],
	};
}

const FUNCTIONS_HEADING = "## Functions";

/**
 * The messages the decision call reads: the prepared ones, with the offered functions (name, description, parameters)
 * listed in a section of the last user message, since a schema call carries no tool definitions. Nothing else changes.
 */
export function decisionMessages(
	messages: readonly ChatMessage[],
	offered: readonly NativeTool[],
): ChatMessage[] {
	const at = messages.map((message) => message.role).lastIndexOf("user");
	const section = [
		FUNCTIONS_HEADING,
		...offered.map((tool) => JSON.stringify(tool.function)),
	].join("\n");
	return messages.map((message, i) =>
		i === at
			? { ...message, content: `${message.content}\n\n${section}` }
			: { ...message },
	);
}

export type Decision =
	| { action: "reply" }
	| { action: "call"; call: NativeToolCall }
	| { action: "failed"; check: LocalCheck };

/** The arguments of a decision's call as the tool's own schema reads them: nulls dropped, free-form objects parsed. */
function argumentsOf(name: string, value: Schema): string | null {
	const out: Schema = {};
	for (const [key, property] of Object.entries(value)) {
		if (property === null) continue;
		if (freeFormProperties(name).includes(key)) {
			if (typeof property !== "string") return null;
			try {
				const parsed: unknown = JSON.parse(property);
				if (!isRecord(parsed)) return null;
				out[key] = parsed;
			} catch {
				return null;
			}
		} else out[key] = property;
	}
	return JSON.stringify(out);
}

/** Reads the decision call's text; a call is checked against the tool's schema (`parseCall`) before it is returned. */
export function parseDecision(
	text: string,
	offered: readonly string[],
): Decision {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return { action: "failed", check: "decision_unparsed" };
	}
	if (!isRecord(value)) return { action: "failed", check: "decision_unparsed" };
	if (
		value.action === "reply" &&
		(value.tool === undefined || value.tool === null)
	)
		return { action: "reply" };
	const tool = value.tool;
	if (
		value.action !== "call" ||
		!isRecord(tool) ||
		typeof tool.name !== "string" ||
		!isRecord(tool.arguments)
	)
		return { action: "failed", check: "decision_unparsed" };
	if (!offered.includes(tool.name))
		return { action: "failed", check: "tool_unknown" };
	const serialised = argumentsOf(tool.name, tool.arguments);
	if (serialised === null)
		return { action: "failed", check: "tool_arguments_invalid" };
	const call: NativeToolCall = {
		id: `call_${crypto.randomUUID()}`,
		name: tool.name,
		arguments: serialised,
	};
	try {
		parseCall(call);
	} catch (error) {
		return {
			action: "failed",
			check:
				error instanceof Error && error.message === "unknown_tool"
					? "tool_unknown"
					: "tool_arguments_invalid",
		};
	}
	return { action: "call", call };
}

/* The reply's head: the first sentence that ends at HEAD_MIN characters or later, or HEAD_MAX characters. */
const HEAD_MIN = 12;
const HEAD_MAX = 40;
const SENTENCE_END = /[。！？!?\n]/;
/** Spaces and the emotion emoji a reply may open with: not counted in the head. */
const LEADING = /^[\s\p{Extended_Pictographic}️‍]+/u;

/** Where the head of `text` ends; null while it is not known yet (`final`: the text is whole, so the end is known). */
export function headEnd(text: string, final: boolean): number | null {
	const lead = text.match(LEADING)?.[0].length ?? 0;
	const body = text.slice(lead);
	for (let i = 0; i < body.length; i++) {
		const count = i + 1;
		if (count >= HEAD_MAX || (count >= HEAD_MIN && SENTENCE_END.test(body[i]!)))
			return lead + count;
	}
	return final ? text.length : null;
}

/** A head that asks something, or that says the agent could not: a reply after a search that hands nothing over. */
const QUESTION = /[？?]|か[。.]?\s*$/;
const REFUSAL = /できません|できない|見つかりません|ありません|ございません/;
/**
 * The words of a deed promised or said as done (the tool-call reliability design, section 5.5). The progressive and
 * waiting forms (`〜ています`, `〜ておきます`, `お待ちください`) are out: "猫の絵を今作っています" is the right reply while
 * the job runs.
 */
const PROMISE =
	/(作り|描き|生成し|作成し|再生し|検索し|調べ|予約し|設定し|表示し|流し|お送りし|お作りし|お調べし)(ます|ました|いたします|いたしました)|できあがり|完成し|進めてまいります/;
/** The user asks to hear the last reply again: a head that repeats it is then right. */
const ASKS_AGAIN = /もう(一回|一度)|聞き取れ|[なん何]て言った/;
/** A head this short may repeat the last reply (an acknowledgement); a longer one is a copy. */
const COPY_MIN = 8;
/** A run of this many characters shared with the last reply is a copy. */
const COPY_RUN = 20;
const HEADING = /^## /m;

/** What the checks know of the turn, drawn from its messages. */
export type TurnFacts = {
	/** A tool was called in this generation. */
	called: boolean;
	/** The latest tool result of this generation is a search that returned candidates. */
	searched: boolean;
	/** The agent's latest reply in the prepared messages. */
	previous: string | null;
	/** The user's words ask to hear it again. */
	asksAgain: boolean;
};

/** The user's words of the last prepared message (`## User`). */
function userWords(message: ChatMessage | undefined): string {
	const open = `${INPUT_HEADINGS.user}\n`;
	const content = message?.content ?? "";
	const at = content.startsWith(open) ? 0 : content.indexOf(`\n${open}`);
	if (at < 0) return "";
	const start = content.indexOf(open, at) + open.length;
	const next = content.indexOf("\n\n## ", start);
	return content.slice(start, next < 0 ? undefined : next);
}

/** The facts of a turn: `base` is the prepared messages, `own` what this generation added after them. */
export function turnFacts(
	base: readonly ChatMessage[],
	own: readonly ChatMessage[],
): TurnFacts {
	const searches = new Set(
		own.flatMap((message) =>
			(message.tool_calls ?? [])
				.filter((call) => call.function.name === TOOL_NAMES.search)
				.map((call) => call.id),
		),
	);
	const latest = [...own].reverse().find((m) => m.role === "tool");
	const previous = [...base]
		.reverse()
		.find((message) => message.role === "assistant" && message.content.trim());
	return {
		called: own.some((message) => message.tool_calls?.length),
		searched:
			!!latest?.tool_call_id &&
			searches.has(latest.tool_call_id) &&
			!!latest.content.trim() &&
			!latest.content.startsWith(NO_CANDIDATES) &&
			!latest.content.startsWith("- refused:"),
		previous: previous?.content ?? null,
		asksAgain: ASKS_AGAIN.test(userWords(base.at(-1))),
	};
}

const squeeze = (text: string) => text.replace(/\s+/g, "");

/** Whether two texts share a run of `COPY_RUN` characters (spaces left out). */
function sharesRun(head: string, previous: string): boolean {
	if (head.length < COPY_RUN) return false;
	const windows = new Set<string>();
	for (let i = 0; i + COPY_RUN <= previous.length; i++)
		windows.add(previous.slice(i, i + COPY_RUN));
	for (let i = 0; i + COPY_RUN <= head.length; i++)
		if (windows.has(head.slice(i, i + COPY_RUN))) return true;
	return false;
}

/**
 * The check a whole reply fails after a search that found candidates: it neither asks nor says the agent could not.
 * Before such a reply is known to the end it is not published (the head alone would stop a statement that goes on
 * to ask).
 */
export function replyCheck(reply: string, facts: TurnFacts): LocalCheck | null {
	const text = reply.replace(LEADING, "");
	return facts.searched && !QUESTION.test(text) && !REFUSAL.test(text)
		? "searched_not_handed"
		: null;
}

/**
 * The first check a reply's head fails, or null. `copies` is the system-copy check of the harness's gate (absent
 * when the gate is off).
 */
export function headCheck(
	head: string,
	facts: TurnFacts,
	copies?: (text: string) => boolean,
): LocalCheck | null {
	const text = head.replace(LEADING, "");
	if (HEADING.test(text) || copies?.(text)) return "input_copied";
	if (!facts.called && PROMISE.test(text)) return "promise_without_call";
	if (facts.previous && !facts.asksAgain) {
		const said = squeeze(text);
		const before = squeeze(facts.previous);
		if (
			(said.length >= COPY_MIN && before.startsWith(said)) ||
			sharesRun(said, before)
		)
			return "previous_reply_copied";
	}
	return null;
}

/** What a model call gave: the speech published (already through the output gate) and the calls it made. */
export type TurnResult = {
	text: string;
	toolCalls: NativeToolCall[];
	receipt: Receipt;
};

/** The calls a turn makes; each is one model call of the generation. */
export type TurnPorts = {
	/** The silent decision call: its receipt's value is the decision JSON. Nothing is published. */
	decide(): Promise<Receipt>;
	/**
	 * The reply call, with the tools offered and none callable; its text goes to `onDelta`, which returns `false` for a
	 * piece it holds (not published) and throws to stop the call once a check failed (the call must then leave its
	 * request usable for the cloud call).
	 */
	reply(onDelta: (text: string) => void | false): Promise<Receipt>;
	/** The single call on the cloud, published as a cloud-harness call is. Throws when the route allows none. */
	cloud(): Promise<TurnResult>;
};

/** The output gate of the turn: what is given to `delta` is published; `finish` returns the speech. */
export type TurnOutput = {
	delta(text: string): void;
	finish(text: string): string;
};

/** Thrown from the reply's delta to stop the call once a check failed. */
class HeadFailed extends Error {}

/**
 * One turn of the local harness. `base` and `own` are the prepared messages and what the generation added after
 * them. A failed check logs only its name, publishes nothing of the local answer, and answers on the cloud; a cloud
 * that cannot answer ends the turn with its error.
 */
export async function runLocalTurn(
	ports: TurnPorts,
	input: {
		base: readonly ChatMessage[];
		own: readonly ChatMessage[];
		offered: readonly string[];
		output: TurnOutput;
		copies?: (text: string) => boolean;
		signal: AbortSignal;
	},
): Promise<TurnResult> {
	const toCloud = (check: LocalCheck) => {
		log.warn("dialogue.local_turn_failed", { reason: check });
		log.info("dialogue.cloud_fallback", { reason: check });
		return ports.cloud();
	};
	// With no tool offered (the call limit is reached) there is nothing to decide: the reply is the only answer.
	if (input.offered.length) {
		const decided = await ports.decide();
		input.signal.throwIfAborted();
		const decision = parseDecision(String(decided.value ?? ""), input.offered);
		if (decision.action === "failed") return toCloud(decision.check);
		if (decision.action === "call")
			return {
				text: input.output.finish(""),
				toolCalls: [decision.call],
				receipt: decided,
			};
	}

	const facts = turnFacts(input.base, input.own);
	// After a search with candidates the reply is held to its end (`replyCheck`); otherwise the head releases it.
	const hold = facts.searched;
	let text = "";
	let released = false as boolean;
	let headChecked = false as boolean;
	let failed = null as LocalCheck | null;
	/** Stops the reply call: nothing of it has been published. */
	const fail = (check: LocalCheck): never => {
		failed = check;
		throw new HeadFailed();
	};
	const publish = () => {
		released = true;
		input.output.delta(text);
	};
	/** The head is known: check it; publish it and what followed unless the whole reply is awaited. */
	const checkHead = (end: number) => {
		const check = headCheck(text.slice(0, end), facts, input.copies);
		if (check) fail(check);
		headChecked = true;
		if (!hold) publish();
	};
	/** `false` says the piece is held: inference must not count it as published. */
	const onDelta = (part: string): void | false => {
		text += part;
		if (released) return input.output.delta(part);
		if (!headChecked) {
			const end = headEnd(text, false);
			if (end !== null) checkHead(end);
		}
		return released ? undefined : false;
	};
	let receipt: Receipt;
	try {
		receipt = await ports.reply(onDelta);
		input.signal.throwIfAborted();
		if (!released && !failed) {
			text = String(receipt.value ?? "");
			if (receipt.toolCalls?.length)
				// The reply fell back to the cloud and the cloud called a tool: its decision, not a reply to check.
				publish();
			else {
				if (!headChecked) checkHead(headEnd(text, true)!);
				if (!released) {
					const check = replyCheck(text, facts);
					if (check) fail(check);
					publish();
				}
			}
		}
	} catch (error) {
		input.signal.throwIfAborted();
		if (!failed) throw error;
		return toCloud(failed);
	}
	if (failed) return toCloud(failed);
	return {
		text: input.output.finish(String(receipt.value ?? "")),
		toolCalls: receipt.toolCalls ?? [],
		receipt,
	};
}
