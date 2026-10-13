import {
	TESTER_ACTIONS,
	type TesterAction,
	type TesterActionName,
} from "./types";

/**
 * The seam between the runner and whatever model plays the tester. An adapter turns one
 * observation (screenshot + accessibility snapshot + goal) into the model's raw text; the
 * runner parses that text, so a malformed reply is counted and handled uniformly for every
 * adapter. Replacing the model means implementing this interface only.
 */
export type TesterInput = {
	goal: string;
	allowedSurface: string;
	step: number;
	remaining: { wallSeconds: number; actions: number; modelCalls: number };
	/** The latest operations and what happened, oldest first. No reasoning is carried over. */
	history: Array<{ step: number; summary: string; result: string }>;
	/** Accessibility snapshot with `[ref=eN]` markers. */
	snapshot: string;
	screenshot: {
		mime: "image/jpeg";
		bytes: Uint8Array;
		width: number;
		height: number;
	};
	/** Set when the previous reply was unusable, so the model can correct the format. */
	correction?: string;
};
export type TesterReply = {
	text: string;
	usage?: { inputTokens: number; outputTokens: number };
	costUSD?: number;
};
export interface TesterAdapter {
	/** Stable label for the manifest, e.g. `larm:ornith1.5`. */
	readonly id: string;
	/** The concrete model id/version once known. */
	modelId(): string | null;
	decide(input: TesterInput, signal: AbortSignal): Promise<TesterReply>;
	close(): Promise<void>;
}

export const MAX_WAIT_SECONDS = 15;
const REF = /^[A-Za-z0-9_-]{1,32}$/;
/** Operations a tester might ask for that the screen-only contract does not allow. */
const FORBIDDEN =
	/^(evaluate|eval|execute|exec|script|run_?script|run_?js|goto|navigate|open_?url|open|fetch|request|http|api|curl|route|intercept|mock|console|network|set_?cookie|storage|db|sql|shell)$/i;

export type ParsedTesterOutput =
	| { ok: true; action: TesterAction }
	| { ok: false; kind: "parse" | "forbidden"; detail: string };

function extractObject(text: string): unknown {
	const unfenced = text.replace(/```(?:json)?/gi, "");
	const start = unfenced.indexOf("{");
	if (start < 0) throw new Error("no_json_object");
	let depth = 0;
	let inString = false;
	for (let i = start; i < unfenced.length; i++) {
		const ch = unfenced[i]!;
		if (inString) {
			if (ch === "\\") i++;
			else if (ch === '"') inString = false;
		} else if (ch === '"') inString = true;
		else if (ch === "{") depth++;
		else if (ch === "}" && --depth === 0)
			return JSON.parse(unfenced.slice(start, i + 1));
	}
	throw new Error("unterminated_json_object");
}

/** Validates the tester's raw text into one screen operation; never executes anything. */
export function parseTesterOutput(text: string): ParsedTesterOutput {
	let raw: unknown;
	try {
		raw = extractObject(text);
	} catch (error) {
		return { ok: false, kind: "parse", detail: (error as Error).message };
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw))
		return { ok: false, kind: "parse", detail: "not_an_object" };
	const o = raw as Record<string, unknown>;
	const name = o.action;
	if (typeof name !== "string")
		return { ok: false, kind: "parse", detail: "action_missing" };
	if (!(TESTER_ACTIONS as readonly string[]).includes(name))
		return FORBIDDEN.test(name)
			? { ok: false, kind: "forbidden", detail: name }
			: { ok: false, kind: "parse", detail: "unknown_action" };
	const action = name as TesterActionName;
	const reason = typeof o.reason === "string" ? o.reason.slice(0, 300) : "";
	const ref = o.ref;
	const argText = o.text;
	if (ref !== undefined && (typeof ref !== "string" || !REF.test(ref)))
		return { ok: false, kind: "parse", detail: "ref_invalid" };
	if (argText !== undefined && typeof argText !== "string")
		return { ok: false, kind: "parse", detail: "text_invalid" };
	if ((action === "click" || action === "fill") && ref === undefined)
		return { ok: false, kind: "parse", detail: "ref_required" };
	if ((action === "fill" || action === "press") && argText === undefined)
		return { ok: false, kind: "parse", detail: "text_required" };
	if (action === "fill" && argText!.length > 200)
		return { ok: false, kind: "parse", detail: "text_too_long" };
	if (action === "wait") {
		const seconds = Number(argText ?? "1");
		if (!Number.isFinite(seconds) || seconds < 0 || seconds > MAX_WAIT_SECONDS)
			return { ok: false, kind: "parse", detail: "wait_out_of_range" };
	}
	return {
		ok: true,
		action: {
			action,
			...(ref !== undefined ? { ref } : {}),
			...(argText !== undefined ? { text: argText } : {}),
			reason,
		},
	};
}

export const TESTER_SYSTEM = [
	"あなたはWebアプリの受入テスターです。利用者の目的を、画面だけを見て操作して達成します。",
	"毎回、現在のスクリーンショットとアクセシビリティスナップショット（要素の ref 付き）が渡されます。",
	"許可される操作は次の6つだけです。出力は JSON オブジェクト1つだけで、前後に文章を付けません。",
	'{"action":"click","ref":"e12","reason":"..."} 要素を押す',
	'{"action":"fill","ref":"e7","text":"3","reason":"..."} 入力欄へ入力する',
	'{"action":"press","text":"Enter","ref":"e7","reason":"..."} キーを押す（ref は省略可。F5 は画面の再読み込み）',
	'{"action":"wait","text":"3","reason":"..."} 画面が変わるのを text 秒（最大15）待つ',
	'{"action":"done","reason":"..."} 目的を達成したと判断したとき',
	'{"action":"give_up","reason":"..."} 目的を達成できないと判断したとき',
	"ref はスナップショットに現れるものだけを使います。URL の入力、開発者ツール、スクリプト実行、通信の操作、API の直接呼出しはできません。",
	"画面に表示された内容を根拠にし、見えていないことを推測で補いません。完了の判定は別の検査者が行うため、done は自分の判断です。",
].join("\n");

/** The allowed surface in the tester's words. It names areas, never controls or steps. */
const surfaceText = {
	"isolated-eumenes-browser": "このWebアプリの画面全体",
	"isolated-eumenes-artifacts":
		"このWebアプリの作業画面（アーティファクト）と画面上部の入口だけ。会話欄（メッセージの入力・送信）は使えない",
} as const;

export function testerUserText(input: TesterInput): string {
	const lines = [
		`目的: ${input.goal}`,
		`操作できる範囲: ${surfaceText[input.allowedSurface as keyof typeof surfaceText] ?? input.allowedSurface}（画面操作のみ）`,
		`ステップ ${input.step}。残り: 時間${Math.max(0, Math.round(input.remaining.wallSeconds))}秒 / 操作${input.remaining.actions}回 / 呼出し${input.remaining.modelCalls}回`,
	];
	if (input.history.length) {
		lines.push("直近の操作:");
		for (const h of input.history)
			lines.push(`- ${h.step}: ${h.summary} → ${h.result}`);
	}
	if (input.correction)
		lines.push(`前回の返答は使えませんでした: ${input.correction}`);
	lines.push(
		"アクセシビリティスナップショット:",
		input.snapshot,
		"次の操作をJSONで返してください。",
	);
	return lines.join("\n");
}

/** A deterministic adapter for tests and for replaying a recorded decision list. */
export function scriptedTester(
	replies: string[],
	id = "scripted",
): TesterAdapter {
	let i = 0;
	return {
		id,
		modelId: () => id,
		async decide() {
			const text = replies[Math.min(i++, replies.length - 1)];
			if (text === undefined) throw new Error("scripted_tester_empty");
			return { text, usage: { inputTokens: 1, outputTokens: 1 }, costUSD: 0 };
		},
		async close() {},
	};
}
