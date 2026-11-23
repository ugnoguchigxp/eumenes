import { z } from "zod";
import type { ClaudeQuestion } from "./claude-contracts";

export const askUserQuestionInput = z.object({
	questions: z
		.array(
			z.object({
				question: z.string().min(1).max(600),
				header: z.string().max(120).optional(),
				options: z
					.array(
						z.object({
							label: z.string().min(1).max(200),
							description: z.string().max(400).optional(),
						}),
					)
					.max(8)
					.default([]),
				multiSelect: z.boolean().optional(),
			}),
		)
		.min(1)
		.max(8),
});

export type EngineQuestion = Pick<
	ClaudeQuestion,
	"id" | "prompt" | "expiresAt" | "kind" | "tool" | "options" | "multiSelect"
>;

export function formatAskQuestion(
	question: z.infer<typeof askUserQuestionInput>["questions"][number],
	index: number,
	total: number,
	expiresAt: number,
): EngineQuestion {
	const prefix = total > 1 ? `[${index + 1}/${total}] ` : "";
	const header = question.header ? `【${question.header}】` : "";
	const hint = question.multiSelect ? "（複数選択可）" : "";
	const optionLines = question.options.map(({ label, description }) =>
		description ? `- ${label}: ${description}` : `- ${label}`,
	);
	const prompt = [
		`${prefix}${header}${question.question}${hint}`,
		...optionLines,
	]
		.join("\n")
		.slice(0, 2_000);
	return {
		id: crypto.randomUUID(),
		prompt,
		expiresAt,
		kind: "question",
		...(question.options.length
			? { options: question.options.map(({ label }) => label) }
			: {}),
		...(question.multiSelect ? { multiSelect: true } : {}),
	};
}

export function formatPermissionQuestion(
	tool: string,
	raw: Record<string, unknown>,
	options: { title?: string; decisionReason?: string; blockedPath?: string },
	expiresAt: number,
): EngineQuestion {
	const detail = summarizeToolInput(tool, raw, options.blockedPath);
	const lines = [
		`Claude Code が追加許可を求めています: ${options.title ?? tool}`,
		...(detail ? [`対象: ${detail}`] : []),
		...(options.decisionReason ? [`理由: ${options.decisionReason}`] : []),
		"許可する場合は「許可する」、拒否する場合は「拒否する」と回答してください。",
	];
	return {
		id: crypto.randomUUID(),
		prompt: lines.join("\n").slice(0, 2_000),
		expiresAt,
		kind: "permission",
		tool: tool.slice(0, 80),
		options: ["許可する", "拒否する"],
	};
}

function summarizeToolInput(
	tool: string,
	raw: Record<string, unknown>,
	blockedPath?: string,
): string {
	if (tool === "Bash" && typeof raw.command === "string")
		return raw.command.slice(0, 500);
	const file =
		blockedPath ??
		(typeof raw.file_path === "string"
			? raw.file_path
			: typeof raw.path === "string"
				? raw.path
				: undefined);
	if (file) return file.slice(0, 500);
	try {
		return JSON.stringify(raw).slice(0, 500);
	} catch {
		return "";
	}
}

const DENY_PATTERN =
	/\b(no|deny|denied|reject|cancel|forbid|disallow|abort)\b|拒否|不可|だめ|ダメ|やめて|中止|キャンセル|許可しない|不許可/i;
const ALLOW_PATTERN =
	/\b(yes|allow|approve|approved|ok|okay|permit|proceed|continue)\b|許可|承認|はい|いいよ|問題ない|進めて|実行して/i;

export function isPermissionApproved(answer: string | null): boolean {
	if (!answer) return false;
	const trimmed = answer.trim();
	if (!trimmed || DENY_PATTERN.test(trimmed)) return false;
	return ALLOW_PATTERN.test(trimmed);
}
