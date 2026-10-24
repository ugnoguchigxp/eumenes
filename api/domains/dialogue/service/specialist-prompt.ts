import { z } from "zod";
import { systemContext } from "../../../infrastructure/system-context";
import {
	actionFieldViolation,
	agentControl,
	rejectedOutputMessage,
	type ControlContract,
} from "../../inference";
import type { SpecialistSet } from "../contracts";
import {
	isBriefSpokenReply,
	SPOKEN_REPLY_MAX_CHARS,
	SPOKEN_REPLY_MAX_SENTENCES,
	spokenReplyMeasure,
} from "../../delivery";

/**
 * The specialist's whole contract: one object whose `action` says what the turn does. A flat object
 * (not a union) so that a model fills one shape; the host checks which fields the action needs.
 * The descriptions are the model-facing contract and one example per action sits in `action`'s. The
 * schema carries no top-level `examples`: `controlInstructions` would then render only those and drop
 * the descriptions.
 */
const outputShape = z
	.object({
		action: z
			.enum(["reply", "invoke", "return", "discard"])
			.describe(
				[
					'reply=利用者への短い説明・質問・完了報告。必須条件が欠けるとき、または停止・破棄・復帰の意図が曖昧なときは、確認を一つだけ尋ねる。例 {"action":"reply","text":"どの題材にしますか。"}',
					'invoke=TOOLSの登録操作を一つ実行する。textを付けると、操作が成功したときにそのtextで利用者へ答えてターンを終える（次の推論はしない）。textを付けないと、TOOL_RESULTを読んでから次を決める。TOOL_RESULTがok:falseなら、errorとdetail・issuesを基に直して同じターンでinvokeし直す。callsLeftが1のときのinvokeには必ずtextを付ける。例 {"action":"invoke","tool":"<TOOLSのid>","arguments":{},"text":"見出しを大きくしました。"}',
					'return=担当範囲外の依頼、または復帰の依頼で、担当を離れる。例 {"action":"return","forward":true}',
					'discard=利用者が未保存作業の破棄を明示したときだけ使う。例 {"action":"discard","text":"破棄しました。"}',
				].join("\n"),
			),
		text: z
			.string()
			.trim()
			.max(SPOKEN_REPLY_MAX_CHARS)
			.refine(isBriefSpokenReply)
			.optional()
			.describe(
				"短い返答。replyでは必須。invokeでは操作が成功したときの返答（任意）。音声で聞かれるため通常一文、補足込みでも二文・300字以内。制作物や実装内容は読み上げない。",
			),
		tool: z
			.string()
			.min(1)
			.max(64)
			.optional()
			.describe("invokeのときだけ必須。TOOLSのid。"),
		arguments: z
			.record(z.string(), z.unknown())
			.optional()
			.describe(
				"invokeのときだけ。成果物本体を入れ、依頼された内容を省略しない。依頼の変更箇所だけを反映し、未指定の項目は作業を進められる範囲で仮置きする。",
			),
		forward: z
			.boolean()
			.optional()
			.describe(
				"returnのときだけ必須。true=担当範囲外の依頼を、原文のまま通常担当へ渡す。viewing.refがsavedRefと異なる別作品の編集を求められたときもtrueにし、現在の作業は変えない。false=復帰だけが依頼で、短い返答を添える。未保存の作業は保留される。",
			),
	})
	.strict()
	.describe(
		"返すJSONは一つだけ。長期記憶・World・別会話は参照も更新もできない。",
	);

export type SpecialistAction =
	| { kind: "reply"; text: string }
	| {
			kind: "invoke";
			tool: string;
			arguments: Record<string, unknown>;
			/** The reply when the operation succeeds: the turn then ends without another call. */
			text?: string;
	  }
	| { kind: "return"; forward: boolean; text?: string }
	| { kind: "discard"; text?: string };

/** Per action: the fields it needs and the fields it must not carry (`arguments` is ignored outside invoke). */
const ACTION_FIELDS = {
	reply: { needs: ["text"], refuses: ["tool", "forward"] },
	invoke: { needs: ["tool"], refuses: ["forward"] },
	return: { needs: ["forward"], refuses: ["tool"] },
	discard: { needs: [], refuses: ["tool", "forward"] },
} as const;

type Shape = z.infer<typeof outputShape>;
/** A field counts as given when it has a value (an empty text or tool is none). */
const given = (out: Shape, field: "text" | "tool" | "forward") =>
	field === "forward" ? out.forward !== undefined : !!out[field];

/** The object a model returned, as a typed action; null when it breaks the contract. */
export function parseSpecialistAction(value: unknown): SpecialistAction | null {
	const parsed = outputShape.safeParse(value);
	if (!parsed.success) return null;
	const out = parsed.data;
	if (
		actionFieldViolation(out.action, ACTION_FIELDS[out.action], (field) =>
			given(out, field),
		)
	)
		return null;
	const text = out.text || undefined;
	if (out.action === "reply") return { kind: "reply", text: text! };
	if (out.action === "invoke")
		return {
			kind: "invoke",
			tool: out.tool!,
			arguments: out.arguments ?? {},
			...(text ? { text } : {}),
		};
	if (out.action === "return")
		return { kind: "return", forward: out.forward!, ...(text ? { text } : {}) };
	return { kind: "discard", ...(text ? { text } : {}) };
}

const MAX_VIOLATIONS = 8;

/** One broken point of a rejected output, as data for the repair call. Never carries an input value. */
type SpecialistViolation =
	| { path: string; code: string; expected?: string }
	| {
			path: "text";
			chars: number;
			maxChars: number;
			sentences: number;
			maxSentences: number;
	  }
	| { action: string; missing: string[]; unexpected: string[] };

/**
 * Where a model's output breaks the contract: the schema's path and kind, the reply's measured length
 * against its limits, or the fields the chosen action lacks or must not carry. Empty when it is valid.
 */
export function specialistViolations(value: unknown): SpecialistViolation[] {
	const parsed = outputShape.safeParse(value);
	if (parsed.success) {
		const out = parsed.data;
		const found = actionFieldViolation(
			out.action,
			ACTION_FIELDS[out.action],
			(field) => given(out, field),
		);
		return found ? [found] : [];
	}
	const found = parsed.error.issues.map((issue) => {
		const path = issue.path.map(String).join(".");
		if (
			path === "text" &&
			(issue.code === "custom" || issue.code === "too_big")
		) {
			const text = (value as { text?: unknown }).text;
			const measured = spokenReplyMeasure(typeof text === "string" ? text : "");
			return {
				path: "text" as const,
				chars:
					issue.code === "too_big" && typeof text === "string"
						? text.trim().length
						: measured.chars,
				maxChars: SPOKEN_REPLY_MAX_CHARS,
				sentences: measured.sentences,
				maxSentences: SPOKEN_REPLY_MAX_SENTENCES,
			};
		}
		return {
			path,
			code: issue.code,
			...("expected" in issue && typeof issue.expected === "string"
				? { expected: issue.expected }
				: {}),
		};
	});
	// A reply that is too long can fail the length and the brevity checks at once: one entry says it.
	return found
		.filter(
			(entry, index) =>
				found.findIndex(
					(other) => JSON.stringify(other) === JSON.stringify(entry),
				) === index,
		)
		.slice(0, MAX_VIOLATIONS);
}

const RULES = systemContext("dialogue.contexts.specialist-turn.rules", {});
const CORRECTION = systemContext(
	"dialogue.contexts.specialist-turn.correction",
	{},
);

/**
 * The specialist's fixed instructions: the package's profile and SKILL, the generic specialist rules and
 * the tools (the binding's and the host's). No conversation, memory or World layer joins them.
 */
export function specialistControl(
	set: SpecialistSet,
	/** The host's tools for this session (document tools, shared toolchains), after the binding's own. */
	hostTools: ReadonlyArray<{
		id: string;
		description: string;
		inputSchema: unknown;
	}> = [],
): ControlContract {
	return agentControl({
		profile: set.profile,
		skills: set.skills,
		rules: RULES,
		tools: [
			...set.tools.map((tool) => ({
				id: tool.id,
				description: tool.summary,
				inputSchema: tool.schema,
			})),
			...hostTools,
		],
		outputSchema: z.toJSONSchema(outputShape),
	});
}

/** The rejected output as data with where it broke the contract, and the instruction to answer again. */
export const correctionMessage = (
	raw: string,
	violations: SpecialistViolation[],
	/** Model calls the turn has left after this one. */
	callsLeft: number,
) => rejectedOutputMessage(CORRECTION, raw, violations, callsLeft);
