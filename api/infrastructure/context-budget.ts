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

// Han (with extension A and the compatibility block), kana, hangul, and the CJK symbols and full-width forms.
const CJK = /[ᄀ-ᇿ⺀-⿟　-〿぀-ヿ㄀-ㄯ㄰-㆏ㇰ-ㇿ㐀-䶿一-鿿가-힯豈-﫿＀-￯]/u;

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
function estimateJsonTextTokens(json: string): number {
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

/** The part of the model window budgets are planned for: the estimate is not the provider's tokenizer. */
export const PLANNING_WINDOW_SHARE = 0.8;
/**
 * The answer and its thinking, when neither the connection nor the saved settings say how much the model needs.
 * An initial value: measured and revised in stage A of the ContextWindow specification.
 */
export const OUTPUT_RESERVE_DEFAULT_TOKENS = 8192;
/** The least of the planning window the current work (data, request, tool results) may always use. */
export const WORK_AREA_MIN_SHARE = 0.25;
/** The least room the memory and conversation sections need; a smaller window is not used for conversation. */
export const MIN_SECTION_ROOM_TOKENS = 8000;

/** Each section's share of the room `R` and its absolute limit (the ContextWindow specification, section 7.2). */
export const SECTION_LIMITS = {
	profile: { share: 0.25, max: 12_000 },
	episode: { share: 0.08, max: 2_000 },
	log: { share: 0.4, max: 16_000 },
	active: { share: 0.08, max: 4_000 },
	state: { share: 0.08, max: 2_000 },
	now: { share: 0.11, max: 3_000 },
} as const;
export type SectionName = keyof typeof SECTION_LIMITS;

/** The log's targets: moved out above `high`, down to `low`; `keep` stays when a conversation resumes. */
export type LogTargets = {
	cap: number;
	high: number;
	low: number;
	keep: number;
};

/**
 * The budget of one model window: `planned` (C) less the output reserve (O), the fixed part (F) and the least
 * work area (W_min) is the room (R) the sections share. Every section's limit is `min(share × R, max)`, so their
 * sum never exceeds R and the work area of a call is at least W_min. `usable` is false when R is below its least.
 */
export type WindowPlan = {
	window: number;
	planned: number;
	output: number;
	fixed: number;
	workMin: number;
	room: number;
	sections: Record<SectionName, number>;
	log: LogTargets;
	usable: boolean;
};

/** Sized for spoken replies of up to 300 characters (~370 tokens an exchange): about 27 exchanges before a re-construction, the last ~10 after it. */
const LOG_HIGH_MAX_TOKENS = 10_000;
const LOG_KEEP_MAX_TOKENS = 4_000;

/** `high = min(10000, cap)`, `low = high / 2`, `keep = min(4000, low)`: keep ≤ low < high ≤ cap for any cap ≥ 2. */
export function logTargets(cap: number): LogTargets {
	const high = Math.min(LOG_HIGH_MAX_TOKENS, cap);
	const low = Math.floor(high / 2);
	return { cap, high, low, keep: Math.min(LOG_KEEP_MAX_TOKENS, low) };
}

export function planWindow(input: {
	/** The model's window in tokens. */
	window: number;
	/** The fixed instructions and tool definitions (F). */
	fixed: number;
	/** The answer and thinking reserve the connection or settings give; absent: the default. */
	output?: number | null;
}): WindowPlan {
	const planned = Math.floor(input.window * PLANNING_WINDOW_SHARE);
	const output = input.output ?? OUTPUT_RESERVE_DEFAULT_TOKENS;
	const workMin = Math.floor(planned * WORK_AREA_MIN_SHARE);
	const room = Math.max(0, planned - output - input.fixed - workMin);
	const sections = Object.fromEntries(
		Object.entries(SECTION_LIMITS).map(([name, limit]) => [
			name,
			Math.min(Math.floor(room * limit.share), limit.max),
		]),
	) as Record<SectionName, number>;
	return {
		window: input.window,
		planned,
		output,
		fixed: input.fixed,
		workMin,
		room,
		sections,
		log: logTargets(sections.log),
		usable: room >= MIN_SECTION_ROOM_TOKENS,
	};
}

/**
 * The end (exclusive) of the exchange that starts at `roles[start]`: the message and those after it up to the next
 * `user` message, or `end`. A history that loses a whole exchange at a time never starts with an assistant message
 * (an assistant message left over from a run that had no answer to pair with goes alone). At least one message.
 */
export function exchangeEnd(
	roles: readonly string[],
	start: number,
	end: number,
): number {
	let next = start + 1;
	while (next < end && roles[next] !== "user") next++;
	return next;
}

/** One event may take at most this share of the log's cap; a longer text keeps its head (section 8.3). */
export const EVENT_SHARE_OF_LOG = 0.1;

/**
 * The head of `text` within `maxTokens` (estimated), cut at a character boundary, and whether it was cut. The rest
 * stays where the text came from (the conversation's message), never rewritten or summarized here.
 */
export function headWithin(
	text: string,
	maxTokens: number,
): { text: string; cut: boolean } {
	if (estimateTextTokens(text) <= maxTokens) return { text, cut: false };
	const chars = [...text];
	let low = 0;
	let high = chars.length;
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		if (estimateTextTokens(`${chars.slice(0, mid).join("")}…`) <= maxTokens)
			low = mid;
		else high = mid - 1;
	}
	return { text: `${chars.slice(0, low).join("")}…`, cut: true };
}
