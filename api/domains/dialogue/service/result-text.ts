import { replaceResourceUrisIn } from "./resource-text";
import { RESULT_MAX_TOKENS, fitLines, jstDayOf, lineText } from "./input-text";

/** What a TODO's result is rendered from: its number, what was asked, how it ended and what it gave. */
export type ResultSource = {
	/** `t<n>`. */
	ref: string;
	title: string;
	status: "todo" | "waiting" | "done";
	outcome?: string;
	question?: string;
	result: unknown;
	/** The resources the work made, as `a<n>「label」`. */
	made: readonly string[];
	/** `a<n>` of a resource URI; null when it is not in the ledger. */
	resource(uri: string): string | null;
};

const OUTCOMES: Record<string, string> = {
	succeeded: "成功",
	partial: "一部のみ",
	failed: "失敗",
	cancelled: "取消",
	interrupted: "中断",
};
const REPORT_OUTCOMES: Record<string, string> = {
	answered: "確認できました",
	partial: "一部のみ確認できました",
	not_found: "見つかりませんでした",
	candidates_found: "候補が見つかりました。本文は未確認です",
	clarification_required: "確かめることがあります",
	failed: "確認できませんでした",
};

type ReportSource = {
	sourceId?: string;
	title?: string;
	url?: string;
	kind?: string;
	origin?: string;
	speaker?: string;
	createdAt?: string;
};
type Report = {
	outcome?: string;
	coverage?: string;
	summary?: string;
	claims: Array<{ text?: string; evidence?: Array<{ sourceId?: string }> }>;
	limitations?: string[];
	sources: ReportSource[];
	candidateResults?: unknown[];
};

const isReport = (value: unknown): value is Report =>
	!!value &&
	typeof value === "object" &&
	Array.isArray((value as Report).claims) &&
	Array.isArray((value as Report).sources);

/** Where a claim came from, in words: a link for a page, the record's kind for the others. */
function sourceLabel(source: ReportSource): string | null {
	switch (source.kind) {
		case "world_claim":
			return source.origin === "model_hypothesis"
				? "World の記録（仮説）"
				: "World の記録";
		case "world_document":
			return `資料「${lineText(source.title ?? "")}」`;
		case "conversation_source":
			return `${source.speaker === "user" ? "本人" : "自分"}の${source.createdAt ? jstDayOf(source.createdAt) : ""}の発言`;
		default:
			// A link only for a URL that can not break out of it (no space, bracket or control string).
			return source.url && /^https?:\/\/[^\s()<>[\]|]+$/.test(source.url)
				? `[${lineText(source.title ?? "出典").replace(/[[\]]/g, "")}](${source.url})`
				: source.title
					? `「${lineText(source.title)}」`
					: null;
	}
}

function reportLines(report: Report): string[] {
	const byId = new Map(
		report.sources.map((source) => [source.sourceId ?? "", source]),
	);
	const lines: string[] = [];
	const claims = report.claims.filter((claim) => !!claim.text);
	if (claims.length) {
		lines.push("確認できたこと:");
		for (const claim of claims) {
			const labels = [
				...new Set(
					(claim.evidence ?? []).flatMap((evidence) => {
						const source = byId.get(evidence.sourceId ?? "");
						const label = source ? sourceLabel(source) : null;
						return label ? [label] : [];
					}),
				),
			];
			lines.push(
				`- ${lineText(claim.text!)}${labels.length ? `（${labels.join("、")}）` : ""}`,
			);
		}
	}
	const limitations = (report.limitations ?? []).filter((text) => !!text);
	if (limitations.length) {
		lines.push("確認できなかったこと:");
		for (const text of limitations) lines.push(`- ${lineText(text)}`);
	}
	if (report.candidateResults?.length)
		lines.push(
			`- 候補: ${report.candidateResults.length}件（画面の一覧にある）`,
		);
	return lines;
}

/** Fields no answer needs: identifiers, digests and revisions the host and the screen work with. */
const HIDDEN_KEY = /(^id$|Ids?$|Digest$|^digest$|^revision$|Revision$|^kind$)/;

function valueText(value: unknown): string | null {
	if (value === null || value === undefined || value === "") return null;
	if (typeof value === "string") return lineText(value);
	if (typeof value === "number" || typeof value === "boolean")
		return String(value);
	if (Array.isArray(value)) {
		const parts = value.flatMap((item) => {
			const text =
				item && typeof item === "object"
					? objectText(item as Record<string, unknown>)
					: valueText(item);
			return text ? [text] : [];
		});
		return parts.length ? parts.join("、") : null;
	}
	if (typeof value === "object")
		return objectText(value as Record<string, unknown>);
	return null;
}

function objectText(value: Record<string, unknown>): string | null {
	const parts = Object.entries(value).flatMap(([key, item]) => {
		if (HIDDEN_KEY.test(key)) return [];
		const text = valueText(item);
		return text ? [`${key} ${text}`] : [];
	});
	return parts.length ? parts.join("、") : null;
}

/** A result that is not a research report: one item per field, nested fields on their parent's line. */
function fieldLines(result: unknown): string[] {
	if (result === null || result === undefined) return [];
	if (typeof result !== "object" || Array.isArray(result)) {
		const text = valueText(result);
		return text ? [`- ${text}`] : [];
	}
	return Object.entries(result as Record<string, unknown>).flatMap(
		([key, value]) => {
			if (HIDDEN_KEY.test(key)) return [];
			const text = valueText(value);
			return text ? [`- ${key}: ${text}`] : [];
		},
	);
}

/**
 * A TODO's result as the input shows it (the conversation input specification, section 8.2): a head line that says
 * which work it is and how it ended, then the result as items, within `RESULT_MAX_TOKENS`. A resource is its number
 * (`a<n>`), never its URI. `items` is how many claims a research report listed (what `## State` points to later).
 */
export function resultText(
	source: ResultSource,
	maxTokens = RESULT_MAX_TOKENS,
): {
	text: string;
	items: number;
} {
	const name = `${source.ref}「${lineText(source.title)}」`;
	if (source.status === "waiting")
		return {
			text: [
				`${name}の担当から質問があります。`,
				`質問: ${lineText(source.question ?? "")}`,
			].join("\n"),
			items: 0,
		};
	if (source.status !== "done")
		return { text: `${name}は実行中です。`, items: 0 };
	const outcome = source.outcome ?? "succeeded";
	if (
		outcome === "failed" ||
		outcome === "cancelled" ||
		outcome === "interrupted"
	)
		return {
			text: `${name}は${outcome === "failed" ? "失敗しました" : outcome === "cancelled" ? "取り消されました" : "中断されました"}。`,
			items: 0,
		};
	const result = replaceResourceUrisIn(
		source.result,
		(uri) => source.resource(uri) ?? "リソース",
	);
	if (isReport(result)) {
		const head = `${name}の調査が終わりました（${REPORT_OUTCOMES[result.outcome ?? (result.coverage === "partial" ? "partial" : "answered")] ?? "確認できました"}）。`;
		return {
			text: [
				head,
				...fitLines(reportLines(result), maxTokens, source.ref),
			].join("\n"),
			items: result.claims.filter((claim) => !!claim.text).length,
		};
	}
	const head = `${name}が終わりました（${OUTCOMES[outcome] ?? outcome}）。`;
	const made = source.made.length
		? [`- できたもの: ${source.made.join("、")}`]
		: [];
	return {
		text: [
			head,
			...fitLines([...made, ...fieldLines(result)], maxTokens, source.ref),
		].join("\n"),
		items: 0,
	};
}

type Schema = {
	type?: unknown;
	description?: unknown;
	enum?: unknown;
	properties?: Record<string, Schema>;
	required?: unknown;
	items?: Schema;
};

/** A tool's parameters as one line: `name（型、必須）説明`, joined by `、`. */
function parametersText(schema: unknown): string | null {
	const root = schema as Schema;
	if (!root || typeof root !== "object") return null;
	// A schema that is not a flat object of fields is given as it is, field by field.
	if (!root.properties) return valueText(root);
	const required = new Set(Array.isArray(root.required) ? root.required : []);
	const parts = Object.entries(root.properties).map(([name, given]) => {
		const field: Schema = given && typeof given === "object" ? given : {};
		const nested =
			field.type === "object" || field.items?.properties
				? parametersText(field.items?.properties ? field.items : field)
				: null;
		const notes = [
			typeof field.type === "string"
				? field.type === "array" && typeof field.items?.type === "string"
					? `${field.items.type}の配列`
					: field.type
				: null,
			required.has(name) ? "必須" : null,
			Array.isArray(field.enum) ? `値は ${field.enum.join("・")}` : null,
		].filter((note): note is string => !!note);
		const description =
			typeof field.description === "string" ? lineText(field.description) : "";
		return `${name}（${notes.join("、")}）${description}${nested ? `［${nested}］` : ""}`;
	});
	return parts.length ? parts.join("、") : null;
}

type Candidate = {
	id?: unknown;
	title?: unknown;
	summary?: unknown;
	useWhen?: unknown;
	execution?: unknown;
	minImpact?: unknown;
	produces?: unknown;
	inputs?: unknown;
	steps?: unknown;
	targets?: unknown;
};

function candidateLine(candidate: Candidate): string {
	const text = (value: unknown) =>
		typeof value === "string" ? lineText(value) : null;
	const parts = [
		text(candidate.title),
		text(candidate.summary),
		text(candidate.useWhen) ? `使うとき: ${text(candidate.useWhen)}` : null,
		text(candidate.execution)
			? `execution: ${text(candidate.execution)}`
			: null,
		text(candidate.minImpact) ? `影響: ${text(candidate.minImpact)}` : null,
		Array.isArray(candidate.produces) && candidate.produces.length
			? `作るもの: ${candidate.produces.map(String).join("・")}`
			: null,
		parametersText(candidate.inputs)
			? `inputs: ${parametersText(candidate.inputs)}`
			: null,
		Array.isArray(candidate.steps) && candidate.steps.length
			? `手順: ${candidate.steps.map((step) => valueText(step) ?? "").join(" → ")}`
			: null,
		Array.isArray(candidate.targets) && candidate.targets.length
			? `target: ${(
					candidate.targets as Array<{ ref?: unknown; label?: unknown }>
				)
					.map(
						(target) =>
							`${String(target.ref)}「${lineText(String(target.label ?? ""))}」`,
					)
					.join("、")}`
			: null,
	].filter((part): part is string => !!part);
	return `- ${String(candidate.id)}: ${parts.join("。")}`;
}

/**
 * A fixed tool's result as the model reads it (the conversation input specification, section 9): text in the
 * input's form, never JSON. The search lists its candidates one per line with how to use them; the others name
 * their fields one per line.
 */
export function toolResultText(name: string, result: unknown): string {
	// A result the host drew as text already (a work check reads like the host notice).
	if (typeof result === "string") return result;
	const record =
		result && typeof result === "object" && !Array.isArray(result)
			? (result as Record<string, unknown>)
			: null;
	if (name === "find_toolchain" && record && Array.isArray(record.candidates)) {
		const lines = (record.candidates as Candidate[]).map(candidateLine);
		const rest = fieldLines({ ...record, candidates: undefined });
		return fitLines(
			lines.length ? [...lines, ...rest] : ["- 候補なし", ...rest],
			RESULT_MAX_TOKENS,
		).join("\n");
	}
	if (name === "memory" && record && Array.isArray(record.items)) {
		const lines = (record.items as Array<Record<string, unknown>>).map((item) =>
			memoryItemLine(item),
		);
		return fitLines(
			lines.length ? lines : ["- 見つかりませんでした"],
			RESULT_MAX_TOKENS,
		).join("\n");
	}
	const lines = fieldLines(result);
	return lines.length
		? fitLines(lines, RESULT_MAX_TOKENS).join("\n")
		: "- なし";
}

const MEMORY_SOURCES: Record<string, string> = {
	user_said: "本人の発言",
	observed: "観察",
};

/** One long-term memory item: its text, then where it came from and since when (`- …（本人の発言、10-20から）`). */
export function memoryItemLine(item: Record<string, unknown>): string {
	const notes = [
		item.negated === true ? "否定" : null,
		typeof item.source === "string"
			? (MEMORY_SOURCES[item.source] ?? null)
			: null,
		typeof item.since === "string" ? `${item.since.slice(5, 10)}から` : null,
		typeof item.until === "string" ? `${item.until.slice(5, 10)}まで` : null,
		item.inProfile === true ? "「## Memory」にある" : null,
	].filter((note): note is string => !!note);
	return `- ${lineText(String(item.text ?? ""))}${notes.length ? `（${notes.join("、")}）` : ""}`;
}
