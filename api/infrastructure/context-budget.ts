/**
 * The size of a model-visible context, as tokens: the estimate every domain uses to judge a budget, and the split
 * of a model window into the two budgets the conversation is assembled for (the ContextWindow design, sections
 * 4.4 and 5.6). It sits in the lowest layer because LARM, memory and inference all need it. The estimate is for
 * judging a budget only, never for billing or usage.
 */

/** Every coefficient of the estimate, in one place. */
export const TOKEN_ESTIMATE = {
	/** Han, kana, hangul and the full-width forms: one token per character. */
	cjkTokensPerChar: 1,
	/** Everything else: UTF-8 bytes per token. */
	otherBytesPerToken: 4,
	/** The structure characters of JSON (`{}[]",:`) are short tokens of their own: characters per token. */
	jsonStructureCharsPerToken: 2,
	/** The role and framing of one chat message. */
	messageOverheadTokens: 4,
	/** The framing of the whole request. */
	requestOverheadTokens: 3,
	/** One attached image (its bytes are not text; a flat allowance). */
	imageTokens: 1600,
} as const;

/** The window the budgets are cut for when the window of the model is not known yet (256k tokens). */
export const REFERENCE_WINDOW_TOKENS = 262_144;
/** The most the memory and conversation history may take (128k tokens). */
export const MEMORY_HISTORY_MAX_TOKENS = 131_072;
/** The most of the window kept for the model's answer. */
export const OUTPUT_RESERVE_MAX_TOKENS = 4096;

// Han (with extension A and the compatibility block), kana, hangul, and the CJK symbols and full-width forms.
const CJK =
	/[ᄀ-ᇿ⺀-⿟　-〿぀-ヿ㄀-ㄯ㄰-㆏ㇰ-ㇿ㐀-䶿一-鿿가-힯豈-﫿＀-￯]/u;

/** Tokens of a text: CJK and kana count one per character, the rest by UTF-8 bytes. */
export function estimateTextTokens(text: string): number {
	let cjk = 0;
	let bytes = 0;
	for (const char of text) {
		if (CJK.test(char)) cjk++;
		else bytes += Buffer.byteLength(char, "utf8");
	}
	return Math.ceil(
		cjk * TOKEN_ESTIMATE.cjkTokensPerChar +
			bytes / TOKEN_ESTIMATE.otherBytesPerToken,
	);
}

const STRUCTURE = /[{}[\]",:]/g;
/** Tokens of a JSON text: the structure characters are counted apart from the text between them. */
export function estimateJsonTextTokens(json: string): number {
	const structure = json.match(STRUCTURE)?.length ?? 0;
	return (
		Math.ceil(structure / TOKEN_ESTIMATE.jsonStructureCharsPerToken) +
		estimateTextTokens(json.replace(STRUCTURE, ""))
	);
}

/** Tokens of a value written as JSON. */
export function estimateJsonTokens(value: unknown): number {
	return estimateJsonTextTokens(JSON.stringify(value) ?? "");
}

type EstimatedMessage = {
	content: string;
	images?: readonly unknown[] | undefined;
	tool_calls?: unknown;
};

/** Tokens of a chat request: each message's text and role framing, its tool calls, its images. */
export function estimateMessageTokens(
	messages: readonly EstimatedMessage[],
): number {
	let tokens = TOKEN_ESTIMATE.requestOverheadTokens;
	for (const message of messages) {
		tokens += TOKEN_ESTIMATE.messageOverheadTokens;
		tokens += estimateTextTokens(message.content);
		if (message.tool_calls) tokens += estimateJsonTokens(message.tool_calls);
		tokens += (message.images?.length ?? 0) * TOKEN_ESTIMATE.imageTokens;
	}
	return tokens;
}

/** The two budgets of a window: memory and conversation history, and the current task. */
export type ContextBudgets = { memoryHistory: number; task: number };

/**
 * `min(128k, window / 2)` for the memory and the conversation history; the rest for the current task (the
 * persona and rules, this turn's data, the request, the tool definitions and the answer's reservation).
 */
export function contextBudgets(windowTokens: number): ContextBudgets {
	const memoryHistory = Math.min(
		MEMORY_HISTORY_MAX_TOKENS,
		Math.floor(windowTokens / 2),
	);
	return { memoryHistory, task: windowTokens - memoryHistory };
}

/** What a window keeps for the answer: part of the task budget, never the memory and history budget. */
export function outputReserveTokens(windowTokens: number): number {
	return Math.min(OUTPUT_RESERVE_MAX_TOKENS, Math.floor(windowTokens / 4));
}
