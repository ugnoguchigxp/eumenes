/**
 * What each model call of a step did, for finding out why a step failed: the call's kind, the tool calls it returned
 * (or the choice it made) with the host's verdict on each, the choice's raw JSON, the head of the text that arrived,
 * the finish reason, and how an error stopped it. The conversations are synthetic, so arguments and texts are recorded as they were. Pure
 * helpers; nothing here calls a model.
 */
import { ValidationFailure } from "../../api/infrastructure/validation-log";
import type { CallKind } from "./harness-client";

/** An argument string shows at most this much; the rest is cut with `…`. */
export const ARGUMENT_CHARS = 300;
/** A choice's raw JSON shows at most this much. */
export const CHOICE_CHARS = 500;
/** The head of the text that arrived. */
export const HEAD_CHARS = 200;

export const cut = (text: string, max: number) =>
	text.length > max ? `${text.slice(0, max)}…` : text;

/** A refused call's issue: where the arguments went wrong and what was allowed there. */
export type Issue = {
	path: string;
	code: string;
	actualType?: string;
	expectedType?: string;
	allowed?: unknown[];
	keys?: unknown[];
};

/** The host's verdict on one tool call. */
export type CallVerdict = {
	name: string;
	/** The arguments as the model sent them, cut. */
	arguments: string;
	verdict: "accepted" | "refused";
	/** Why it was refused (the check, the validation code, or the simulated host's own reason). */
	reason?: string;
	issues?: Issue[];
	/** What the host answered an accepted call (the candidates' ids, the hand-over). */
	outcome?: string;
};

/** One model call of a step. */
export type CallDetail = {
	kind: CallKind;
	toolCalls: CallVerdict[];
	/** The choice call's raw JSON text, cut. */
	choiceJson?: string;
	/** The head of the text that arrived. */
	text: string;
	textChars: number;
	reasoningChars: number;
	finishReason: string | null;
	/** Why the host did not take this call's answer (a choice it could not carry out, the same reason the retry names). */
	check?: string;
	/** The error that ended the call: its code and how much had arrived. */
	error?: { code: string; textChars: number; reasoningChars: number };
};

export const newDetail = (kind: CallKind): CallDetail => ({
	kind,
	toolCalls: [],
	text: "",
	textChars: 0,
	reasoningChars: 0,
	finishReason: null,
});

/**
 * The issues of a refused call, from the failure the product's validation raised: the exact paths and what is allowed
 * there come from its repair form (the log form masks the path names).
 */
export function issuesOf(failure: ValidationFailure): Issue[] {
	const count = Math.max(failure.issues.length, failure.repair?.length ?? 0);
	return Array.from({ length: Math.min(count, 8) }, (_, i) => {
		const issue = (failure.issues[i] ?? {}) as Record<string, unknown>;
		const repair = failure.repair?.[i] as
			| {
					path?: string;
					code?: string;
					expected?: string;
					allowed?: unknown[];
					keys?: unknown[];
			  }
			| undefined;
		const text = (value: unknown) =>
			typeof value === "string" && value ? value : undefined;
		const actualType = text(issue.actualType);
		const expectedType = repair?.expected ?? text(issue.expectedType);
		return {
			path:
				repair?.path ?? text(issue.validationPath) ?? text(issue.reason) ?? "",
			code:
				repair?.code ??
				text(issue.validationCode) ??
				text(issue.reason) ??
				failure.message,
			...(actualType ? { actualType } : {}),
			...(expectedType ? { expectedType } : {}),
			...(repair?.allowed ? { allowed: repair.allowed.slice(0, 8) } : {}),
			...(repair?.keys ? { keys: repair.keys.slice(0, 8) } : {}),
		};
	});
}

/** A refused call's verdict. */
export function refused(
	name: string,
	args: string,
	reason: string,
	issues?: Issue[],
): CallVerdict {
	return {
		name,
		arguments: cut(args, ARGUMENT_CHARS),
		verdict: "refused",
		reason,
		...(issues?.length ? { issues } : {}),
	};
}

/** An accepted call's verdict. */
export function accepted(
	name: string,
	args: string,
	outcome?: string,
): CallVerdict {
	return {
		name,
		arguments: cut(args, ARGUMENT_CHARS),
		verdict: "accepted",
		...(outcome ? { outcome } : {}),
	};
}

/** The code of an error: its own `code` when it has one, else its message (the product throws codes as messages). */
export function errorCodeOf(error: unknown): string {
	const own = (error as { code?: unknown } | null)?.code;
	return typeof own === "string" && own
		? own
		: error instanceof Error
			? error.message.slice(0, 80)
			: String(error).slice(0, 80);
}

/** Takes text that arrived into the call's detail: its length, and its head. */
export function arrived(detail: CallDetail, delta: string): void {
	detail.textChars += delta.length;
	if (detail.text.length < HEAD_CHARS)
		detail.text = cut(
			`${detail.text}${delta}`.slice(0, HEAD_CHARS),
			HEAD_CHARS,
		);
}

const verdictText = (v: CallVerdict) => {
	const issues = v.issues
		?.map(
			(i) =>
				`${i.path || "(root)"} ${i.code}${i.expectedType ? ` expected ${i.expectedType}` : ""}${i.actualType ? ` got ${i.actualType}` : ""}${i.allowed ? ` allowed ${JSON.stringify(i.allowed)}` : ""}${i.keys ? ` keys ${JSON.stringify(i.keys)}` : ""}`,
		)
		.join("; ");
	return v.verdict === "accepted"
		? `受理${v.outcome ? ` → ${v.outcome}` : ""}`
		: `拒否 ${v.reason ?? ""}${issues ? ` [${issues}]` : ""}`;
};

/** One call of a step as report lines. */
export function detailLines(detail: CallDetail, number: number): string[] {
	const head = [
		`${number}. ${detail.kind}`,
		`finish=${detail.finishReason ?? "-"}`,
		`text ${detail.textChars}字`,
		`推論 ${detail.reasoningChars}字`,
		...(detail.check ? [`check=${detail.check}`] : []),
		...(detail.error
			? [
					`error=${detail.error.code}（届いた text ${detail.error.textChars}字・推論 ${detail.error.reasoningChars}字）`,
				]
			: []),
	].join(" / ");
	return [
		`  - ${head}`,
		...(detail.choiceJson ? [`    - 選択: \`${detail.choiceJson}\``] : []),
		...(detail.text ? [`    - 本文の頭: 「${detail.text}」`] : []),
		...detail.toolCalls.map(
			(v) => `    - ${v.name} \`${v.arguments}\` → ${verdictText(v)}`,
		),
	];
}
