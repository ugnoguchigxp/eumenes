import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { z } from "zod";
import type {
	ExchangeDto,
	MemoryItemDto,
	MemoryService,
} from "../domains/memory";
import type { DecisionDto, StewardService } from "../domains/steward";
import type { AdapterResult, DomainAdapter } from "../domains/tool-runtime";

export const MEMORY_ADAPTER_REF = "adapter:memory@1";
const STATUS = "query:memory.status@1";
const ITEMS = "query:memory.items@1";
const HISTORY = "query:memory.item-history@1";
const TENDENCIES = "query:memory.tendencies@1";
const SHORT_TERM = "query:memory.short-term@1";
const CONTEXT = "query:memory.context@1";
const DECISIONS = "query:memory.steward-decisions@1";
const EXCHANGES = "query:memory.steward-exchanges@1";
/** The conversation whose short-term notes and context the screen shows (the app's one conversation). */
export const MEMORY_SCREEN_CONVERSATION = "main";

const setEnabled = z.strictObject({ enabled: z.boolean() });
const page = z.strictObject({
	pageIndex: z.number().int().min(0).max(100_000).default(0),
	pageSize: z.union([z.literal(10), z.literal(25), z.literal(50)]).default(10),
	sort: z.enum(["text", "kind", "status", "capturedBy"]).optional(),
	desc: z.boolean().default(false),
	q: z.string().max(200).default(""),
});

/** What the memory adapter reads and changes; each is a public operation of the memory domain. */
export type MemoryAdapterPorts = {
	memory: Pick<
		MemoryService,
		| "status"
		| "list"
		| "tendencies"
		| "shortTerm"
		| "storedContext"
		| "setEnabledInTransaction"
	>;
	/** The steward's read model (its decision records and exchange ledger); without it those views are empty. */
	steward?: Pick<StewardService, "decisions" | "exchanges">;
	conversationId?: string;
};

const kindLabels: Record<string, string> = {
	preference: "好み",
	personal_fact: "本人の事実",
	constraint: "制約",
	habit: "習慣",
};
const statusLabels: Record<string, string> = {
	active: "利用中",
	inactive: "停止中",
	superseded: "置き換え済み",
	disputed: "内容に争いあり",
	retracted: "撤回済み",
	invalidated: "根拠が失われ無効",
	forgotten: "消去済み",
};
const capturedByLabels: Record<MemoryItemDto["capturedBy"], string> = {
	request: "頼まれて記憶",
	agent: "会話から自動で記憶",
	manual: "手動登録",
};
const noteKindLabels: Record<string, string> = {
	goal: "目的",
	decision: "決定",
	open_question: "未解決",
	activity: "活動",
	memo: "メモ",
};
const stepLabels: Record<DecisionDto["step"], string> = {
	"curate-memory": "記憶の判断",
	"dispose-exchanges": "履歴の取捨",
	summarize: "要約",
	"prepare-recall": "想起の準備",
	"consolidate-memory": "記憶の整理",
	"compact-history": "履歴の圧縮",
	"refine-summary": "要約の推敲",
};
const outcomeLabels: Record<ExchangeDto["outcome"], string> = {
	answered: "回答あり",
	failed: "回答なし（失敗）",
};
const markLabels: Record<string, string> = {
	done: "済",
	skipped: "見送り",
};
const dispositionLabels: Record<string, string> = {
	keep: "逐語で残す",
	summarize: "要約へ",
	drop: "出さない",
};
const NO_QUOTE = "元の発言は見つかりません";
const CURRENT = new Set(["active", "inactive"]);

const date = (ms: number) => new Date(ms).toLocaleDateString("ja-JP");
function validityText(item: MemoryItemDto) {
	const from =
		item.validity?.from ?? (item.validFromMs ? date(item.validFromMs) : "");
	const until =
		item.validity?.until ?? (item.validUntilMs ? date(item.validUntilMs) : "");
	return from || until ? `${from}〜${until}` : "";
}

function itemRow(item: MemoryItemDto) {
	const quote = item.evidence.find((e) => e.quote)?.quote;
	return {
		id: item.id,
		revision: item.revision,
		kind: item.kind,
		kindLabel: kindLabels[item.kind] ?? item.kind,
		text: item.polarity === "negated" ? `「${item.text}」ではない` : item.text,
		status: item.status,
		statusLabel: statusLabels[item.status] ?? "不明な状態",
		capturedBy: item.capturedBy,
		capturedByLabel: capturedByLabels[item.capturedBy],
		validity: validityText(item),
		quote: quote ? `「${quote}」` : NO_QUOTE,
	};
}
type ItemRow = ReturnType<typeof itemRow>;

const SORT_KEYS: Record<
	NonNullable<z.infer<typeof page>["sort"]>,
	keyof ItemRow
> = {
	text: "text",
	kind: "kindLabel",
	status: "statusLabel",
	capturedBy: "capturedByLabel",
};

/** One page of rows: search over the shown words, an optional sort (stable), then the slice. */
function pageOf(rows: ItemRow[], query: z.infer<typeof page>) {
	const needle = query.q.trim().toLowerCase();
	let found = needle
		? rows.filter((row) =>
				[
					row.text,
					row.kindLabel,
					row.statusLabel,
					row.capturedByLabel,
					row.quote,
				]
					.join("\n")
					.toLowerCase()
					.includes(needle),
			)
		: [...rows];
	if (query.sort) {
		const key = SORT_KEYS[query.sort];
		const sign = query.desc ? -1 : 1;
		found = found
			.map((row, index) => ({ row, index }))
			.sort(
				(a, b) =>
					sign * String(a.row[key]).localeCompare(String(b.row[key]), "ja") ||
					a.index - b.index,
			)
			.map(({ row }) => row);
	}
	const start = query.pageIndex * query.pageSize;
	return {
		pageIndex: query.pageIndex,
		pageSize: query.pageSize,
		total: found.length,
		items: found.slice(start, start + query.pageSize),
	};
}

/** How many decision records (and exchanges) the timeline shows, newest first. */
const DECISION_ROWS = 50;
const PROPOSAL_CHARS = 300;
const dateTime = (iso: string) => new Date(iso).toLocaleString("ja-JP");
const asArray = (value: unknown): unknown[] =>
	Array.isArray(value) ? value : [];

/** What the model proposed, in a line: the size of each list it returned and its free text, bounded. */
function proposalText(output: unknown): string {
	if (output === null || typeof output !== "object") return "";
	const record = output as Record<string, unknown>;
	if (typeof record.redacted === "string")
		return "忘却により本文を消去しました";
	const parts: string[] = [];
	for (const [key, value] of Object.entries(record)) {
		if (Array.isArray(value)) {
			if (value.length > 0) parts.push(`${key} ${value.length}件`);
		} else if (typeof value === "string" && value !== "")
			parts.push(`${key}: ${value}`);
	}
	const text = parts.join(" / ");
	return text.length > PROPOSAL_CHARS
		? `${text.slice(0, PROPOSAL_CHARS)}…`
		: text;
}

/** Applied and rejected counts of a decision's results, with the reason codes of the rejected. */
function resultText(decision: DecisionDto): string {
	if (decision.errorCode) return `採用せず（${decision.errorCode}）`;
	let applied = 0;
	const rejected: string[] = [];
	let unchanged = false;
	for (const entry of asArray(decision.results)) {
		const result = (entry ?? {}) as Record<string, unknown>;
		if (result.status === "applied") applied++;
		else if (result.status === "unchanged") unchanged = true;
		else rejected.push(typeof result.code === "string" ? result.code : "不明");
	}
	if (unchanged) return "変更なし";
	const text = [`適用 ${applied}件`];
	if (rejected.length > 0)
		text.push(`却下 ${rejected.length}件（${rejected.join("、")}）`);
	return text.join(" / ");
}

function decisionRow(decision: DecisionDto) {
	const { windowVersionBefore: before, windowVersionAfter: after } = decision;
	return {
		id: String(decision.id),
		createdAt: dateTime(decision.createdAt),
		stepLabel: stepLabels[decision.step] ?? decision.step,
		proposal: proposalText(decision.output),
		result: resultText(decision),
		windowDiff:
			after === null
				? "変更なし"
				: before === null
					? `版 ${after}`
					: `版 ${before} → ${after}`,
		cost: [
			decision.durationMs === null
				? ""
				: `${(decision.durationMs / 1000).toFixed(1)}秒`,
			decision.outputTokens === null ? "" : `${decision.outputTokens} tokens`,
		]
			.filter(Boolean)
			.join(" / "),
	};
}

function exchangeRow(exchange: ExchangeDto) {
	return {
		id: exchange.inputMessageId,
		ordinal: exchange.inputOrdinal,
		outcomeLabel: outcomeLabels[exchange.outcome],
		stateLabel: exchange.state === "done" ? "反映済み" : "反映待ち",
		curated: markLabels[exchange.curated ?? ""] ?? "未",
		disposed: markLabels[exchange.disposed ?? ""] ?? "未",
		summarized: markLabels[exchange.summarized ?? ""] ?? "未",
		dispositionLabel: exchange.disposition
			? (dispositionLabels[exchange.disposition] ?? exchange.disposition)
			: "未判断",
		createdAt: dateTime(exchange.createdAt),
	};
}

/** The rendered context text is shown in full up to this many characters. */
const CONTEXT_TEXT_CHARS = 1500;
const clip = (text: string) =>
	text === ""
		? "（空）"
		: text.length > CONTEXT_TEXT_CHARS
			? `${text.slice(0, CONTEXT_TEXT_CHARS)}…（以降は省略）`
			: text;
const bytes = (used: number, limit: number) => `${used} / ${limit} byte`;
const sha256 = (value: unknown) =>
	createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** What the memory adapter offers, without domain services (bundle checks, evaluation). */
export const describeMemoryAdapter = () => ({
	owner: "memory",
	operations: new Map(
		([["memory.set-enabled", "schema:memory-set-enabled@1"]] as const).map(
			([name, inputSchemaRef]) => [
				name,
				{ inputSchemaRef, effect: "write" as const },
			],
		),
	),
	queries: new Set([
		STATUS,
		ITEMS,
		HISTORY,
		TENDENCIES,
		SHORT_TERM,
		CONTEXT,
		DECISIONS,
		EXCHANGES,
	]),
	inputAdapters: new Map(),
	projections: new Set<string>(),
	availability: "availability:memory@1",
});

/**
 * The typed memory adapter: the connection state and its switch, the saved items (current and
 * history), tendencies, the short-term notes and the context window. The screen only reads; the one
 * change is the connection switch, which is the memory domain's public transaction operation, so its
 * guards stay in the domain. Memory content is never changed by hand. Conversations cannot use it.
 */
export function createMemoryAdapter(ports: MemoryAdapterPorts): DomainAdapter {
	const { memory, steward } = ports;
	const conversationId = ports.conversationId ?? MEMORY_SCREEN_CONVERSATION;
	function done(
		receipt: Record<string, unknown>,
		requestId: string,
	): AdapterResult {
		return {
			receipt,
			receiptRef: {
				owner: "memory",
				operationId: requestId,
				digest: sha256(receipt),
			},
			resultRefs: [],
			replay: false,
		};
	}
	function parse<T>(schema: z.ZodType<T>, raw: unknown): T {
		const parsed = schema.safeParse(raw);
		if (!parsed.success) throw new Error("invalid_input");
		return parsed.data;
	}
	function invoke(
		tx: Database,
		name: string,
		raw: unknown,
		requestId: string,
	): AdapterResult {
		switch (name) {
			case "memory.set-enabled": {
				const input = parse(setEnabled, raw);
				const status = memory.setEnabledInTransaction(tx, input.enabled);
				// Never leave memory switched on while its journal cannot be trusted.
				if (input.enabled && !status.healthy)
					throw new Error("memory_unavailable");
				return done(
					{
						version: 1,
						kind: "memory-enabled",
						enabled: status.enabled,
						healthy: status.healthy,
					},
					requestId,
				);
			}
			default:
				throw new Error("capability_unavailable");
		}
	}
	function itemsOf(includeCurrent: boolean, params: unknown) {
		const query = parse(page, params ?? {});
		const rows = memory
			.list(true)
			.filter((item) => CURRENT.has(item.status) === includeCurrent)
			.map(itemRow);
		return pageOf(rows, query);
	}
	return {
		ref: MEMORY_ADAPTER_REF,
		describe: describeMemoryAdapter,
		availableInTransaction: () => true,
		snapshotInTransaction: () => ({ items: [] }),
		invokeInTransaction(tx, request) {
			if (request.origin.kind !== "ui")
				throw new Error("capability_unavailable");
			return invoke(
				tx,
				request.operationName,
				request.input,
				request.requestId,
			);
		},
		// Each operation's outcome is read again from the lists: no body to reload.
		readInTransaction: () => null,
		sourceInTransaction(_tx, query, _target, params) {
			switch (query) {
				case STATUS: {
					const status = memory.status();
					return {
						revision: 0,
						data: {
							items: [
								{
									id: "memory",
									enabled: status.enabled,
									healthy: status.healthy,
									state: !status.enabled
										? "非接続"
										: status.healthy
											? "接続中"
											: "利用停止中（接続設定はオン）",
									integrity: status.healthy
										? "正常"
										: "保存した記憶の整合性を確認できないため、一覧は表示しません",
									canConnect: !status.enabled && status.healthy,
								},
							],
						},
					};
				}
				case ITEMS:
					return { revision: 0, data: itemsOf(true, params) };
				case HISTORY:
					return { revision: 0, data: itemsOf(false, params) };
				case TENDENCIES:
					return { revision: 0, data: { items: memory.tendencies() } };
				case SHORT_TERM:
					return {
						revision: 0,
						data: {
							items: memory.shortTerm(conversationId).map((note) => ({
								id: note.id,
								revision: note.revision,
								kind: note.kind,
								kindLabel: noteKindLabels[note.kind] ?? note.kind,
								text: note.text,
								originLabel:
									note.origin === "agent" ? "会話から自動で記録" : "手動登録",
								expiresAt: note.expiresAt,
							})),
						},
					};
				case CONTEXT: {
					const window = memory.storedContext(conversationId);
					const state = !window
						? "まだ組み立てていません。会話の次のターンの準備で組み立てられ、その後ここに表示されます"
						: window.disabled
							? "メモリーを利用していないため、文脈は組み立てていません"
							: "組み立て済み（直近に組み立てた版です）";
					const built = window && !window.disabled ? window : undefined;
					return {
						revision: 0,
						data: {
							items: [
								{
									id: "context",
									state,
									version: built?.version,
									longTerm: built
										? bytes(built.longTerm.bytes, built.longTerm.limit)
										: undefined,
									shortTerm: built
										? bytes(built.shortTerm.bytes, built.shortTerm.limit)
										: undefined,
									pendingAdditions: built?.shortTerm.pendingAdditions,
									notices: built?.notices,
									longTermText: built ? clip(built.longTerm.text) : undefined,
									shortTermText: built ? clip(built.shortTerm.text) : undefined,
								},
							],
						},
					};
				}
				case DECISIONS:
					return {
						revision: 0,
						data: {
							items: (
								steward?.decisions(conversationId, DECISION_ROWS) ?? []
							).map(decisionRow),
						},
					};
				case EXCHANGES:
					return {
						revision: 0,
						data: {
							items: (steward?.exchanges(conversationId) ?? [])
								.slice(-DECISION_ROWS)
								.map(exchangeRow)
								.reverse(),
						},
					};
				default:
					return null;
			}
		},
		targetInput: () => ({}),
	};
}
