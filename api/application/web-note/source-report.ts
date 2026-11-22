import { z } from "zod";
import type { ExecutionResult } from "../../domains/tool-runtime";
import type { SourceExcerpt } from "./source-excerpt";

const location = z.strictObject({
	path: z.string(),
	startLine: z.number().int(),
	endLine: z.number().int(),
	symbol: z.string().max(180).nullable(),
});
type Location = z.infer<typeof location>;
const depths = {
	small: ["小", 3],
	medium: ["中", 4],
	large: ["大", 5],
} as const;
const report = z.strictObject({
	depth: z.enum(["small", "medium", "large"]),
	findings: z.array(
		z.strictObject({
			summary: z.string(),
			evidence: z.array(location),
		}),
	),
	limitations: z.string(),
});
export const sourceReportSchema = z.toJSONSchema(report);

export function formatExcerpt(kind: "diff" | "code", raw: string) {
	const value = raw.slice(0, 4800).trimEnd();
	const longest = Math.max(
		2,
		...(value.match(/`+/gu) ?? []).map((item) => item.length),
	);
	const fence = "`".repeat(longest + 1);
	return `${fence}${kind === "diff" ? "diff" : ""}\n${value}\n${fence}`;
}

function prose(text: string, evidence: Location[]) {
	let summary = text.replace(/```[\s\S]*?(?:```|$)/gu, " ");
	for (const { path } of evidence) {
		const name = path.split("/").at(-1);
		if (path) summary = summary.replaceAll(path, "");
		if (name) summary = summary.replaceAll(name, "");
	}
	return summary
		.replace(
			/(?:eumenes@)?\b(?=[0-9a-f]{7,64}\b)(?=[0-9a-f]*[a-f])[0-9a-f]{7,64}\b/giu,
			"",
		)
		.replace(/(?:[.\p{L}\p{N}_@-]+\/)+[.\p{L}\p{N}_@-]+/gu, "")
		.replace(/\s+/gu, " ")
		.trim()
		.slice(0, 500);
}

const markdown = (text: string) => text.replace(/[\\`*_[\]<>]/gu, "\\$&");

export async function sourceResult(
	text: string,
	lineCounts: ReadonlyMap<string, number>,
	excerpt: (location: Location) => Promise<SourceExcerpt | null>,
	commit: string,
): Promise<ExecutionResult> {
	if (Buffer.byteLength(text) > 12_000)
		throw new Error("inspect_source_output_limit");
	let parsed: z.infer<typeof report>;
	try {
		parsed = report.parse(JSON.parse(text));
	} catch {
		throw new Error("inspect_source_invalid_report");
	}
	const [label, max] = depths[parsed.depth];
	const sources = new Map<string, string>();
	const evidence: NonNullable<ExecutionResult["report"]>["sources"] = [];
	const evidenceClaims: NonNullable<ExecutionResult["report"]>["claims"] = [];
	const seenLocations = new Map<string, string>();
	const claims: string[] = [];
	let partial = Boolean(parsed.limitations.trim());
	for (const finding of parsed.findings.slice(0, 12)) {
		const claim = prose(finding.summary, finding.evidence);
		let supported = false;
		const sourceIds = new Set<string>();
		for (const location of finding.evidence) {
			const { path, startLine, endLine } = location;
			if (
				startLine < 1 ||
				endLine < startLine ||
				endLine > (lineCounts.get(path) ?? 0)
			) {
				partial = true;
				continue;
			}
			const key = JSON.stringify([path, startLine, endLine]);
			const seen = seenLocations.get(key);
			if (seen) {
				sourceIds.add(seen);
				supported = true;
				continue;
			}
			if (
				(!sources.has(path) && sources.size >= max) ||
				evidence.length >= 12
			) {
				partial = true;
				continue;
			}
			const snippet = await excerpt(location);
			if (!snippet) {
				partial = true;
				continue;
			}
			const legend =
				snippet.kind === "diff"
					? "差分（− 元のコード／＋ 現在のコード）"
					: `コードの抜粋（${startLine}行目から）`;
			if (!sources.has(path))
				sources.set(
					path,
					`> **ソース：** \`${path}\`\n\n${legend}\n\n${formatExcerpt(snippet.kind, snippet.text)}`,
				);
			const sourceId = `source-${evidence.length + 1}`;
			seenLocations.set(key, sourceId);
			sourceIds.add(sourceId);
			evidence.push({
				sourceId,
				kind: "source",
				location: {
					path,
					symbol: location.symbol?.trim() || null,
					commit,
					startLine,
					endLine,
					digest: snippet.digest,
				},
			});
			supported = true;
		}
		if (supported && claim) {
			claims.push(claim);
			evidenceClaims.push({ text: claim, sourceIds: [...sourceIds] });
		}
	}
	const summary =
		claims.join("\n").slice(0, 1800) || "今回は表示できる抜粋がありません。";
	const displayAnswer = [
		`**${partial || !sources.size ? "一部抜粋" : "ソース調査"}（表示深度：${label}）**`,
		markdown(summary),
		...sources.values(),
	].join("\n\n");
	return {
		status: partial || !sources.size ? "partial" : "completed",
		title: "ソース調査",
		summary,
		fulfilled: claims.slice(0, 8),
		missing: [],
		refs: [],
		replyInConversation: true,
		answer: summary,
		displayAnswer,
		report: {
			summary,
			coverage: partial || !sources.size ? "partial" : "complete",
			verification: "evidence_linked",
			claims: evidenceClaims,
			limitations: parsed.limitations.trim()
				? [prose(parsed.limitations, [])]
				: [],
			sources: evidence,
		},
	};
}
