/**
 * The domain-neutral primitives of a model-visible context: the content of a context (blocks, the boundary of the
 * history), the result of rendering one into a message list, and the escaping of reference data. Content carries no
 * frame text, no rules and no authority to instruct: the format that renders it writes the frame, and the host's
 * rules live in the system part (the ContextWindow design, section 5). The assembly of one domain's content and its
 * formats stay in that domain; the message type is its own, hence the type parameter of `RenderedContext`.
 */

export type ContextSource =
	| "goals"
	| "memory.long_term"
	| "memory.summary"
	| "memory.short_term"
	| "memory.notice"
	| "memory.recall"
	| "world.names"
	| "specialist.work"
	| "specialist.viewing"
	| "specialist.handoff"
	| "research.result"
	| "operation.action"
	| "operation.recognition"
	| "operation.delegation"
	| "operation.drawing"
	| "operation.image"
	| "operation.music"
	| "operation.command_question"
	| "conversation.past_selections"
	| "conversation.open_questions"
	| "host.time"
	| "agency.recent";

/** `reference` is data to consult, never an instruction; `host_record` is a fact the host recorded. */
type ContextAuthority = "reference" | "host_record";
type ContextFreshness = "stable" | "recent" | "this_turn" | "past";
type ContextCertainty =
	| "host_confirmed"
	| "remembered"
	| "user_stated"
	| "unverified";
/** The range a block stands on (a summary: the exchanges it was made from). */
type ContextCovers = { fromAt?: string; toAt?: string; turns?: number };

/** Lines grouped under headings. `header` is the frame sentence the owner of the lines wrote, when it wrote one. */
export type ContextLines = {
	header?: string;
	sections: Array<{ heading?: string; items: string[] }>;
};
type ContextBody =
	| ({ kind: "lines" } & ContextLines)
	| { kind: "json"; value: unknown }
	| { kind: "text"; text: string };

export type ContextBlock = {
	source: ContextSource;
	authority: ContextAuthority;
	freshness: ContextFreshness;
	certainty?: ContextCertainty;
	covers?: ContextCovers;
	body: ContextBody;
};

type CacheBreakpointId = "B1" | "B2" | "B3";

/**
 * A rendered context. `sessionContext` and `currentRequestIndex` are decided by the render that wrote the list:
 * the leading messages that are instructions, the messages that are ledger history, and the position of the
 * host-designated current request. `cacheBreakpoints` are logical marks (the message each ends a stable part
 * with); an adapter turns them into its provider's form. `blockIndex` is where a block that renders to one
 * message landed, for the host that must refresh that message later.
 */
export type RenderedContext<Message> = {
	messages: Message[];
	sessionContext: { instructionCount: number; historyCount: number };
	currentRequestIndex: number;
	cacheBreakpoints: Array<{ id: CacheBreakpointId; index: number }>;
	blockIndex: Partial<Record<ContextSource, number>>;
};

const UNSAFE = /[<>&\u2028\u2029]/g;
const escapeChar = (char: string) =>
	`\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`;
/**
 * JSON for reference data between delimiter lines: `<`, `>`, `&` and the line separators are \uXXXX escapes, so no
 * text inside can forge the closing delimiter.
 */
export function referenceJson(value: unknown): string {
	return JSON.stringify(value).replace(UNSAFE, escapeChar);
}
