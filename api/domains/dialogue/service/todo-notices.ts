import type { TodoNotice } from "../contracts/todo-notices";
import type { WorkLink } from "../contracts/resources";
import type { WorkRow } from "../repository/work";
import { replaceResourceUrisIn } from "./resource-text";

/** Characters of a notice's result line. */
export const NOTICE_RESULT_CHARS = 200;

const oneLine = (text: string, max: number) => {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

const TEXT_FIELDS = ["answer", "summary", "text", "message", "title", "name"];

/**
 * The result of finished work as one line: its own words where it has them, else its data. A resource URI in it
 * is replaced by `resourceName(uri)` before the line is cut (a notice never shows a URI).
 */
export function resultLine(
	given: unknown,
	resourceName: (uri: string) => string = () => "リソース",
): string | undefined {
	const result = replaceResourceUrisIn(given, resourceName);
	if (result === null || result === undefined) return undefined;
	if (typeof result === "string")
		return oneLine(result, NOTICE_RESULT_CHARS) || undefined;
	if (typeof result === "object" && !Array.isArray(result)) {
		const record = result as Record<string, unknown>;
		for (const key of TEXT_FIELDS)
			if (typeof record[key] === "string" && record[key].trim())
				return oneLine(record[key], NOTICE_RESULT_CHARS);
		// A research report: its claims are the result.
		if (Array.isArray(record.claims)) {
			const claims = record.claims.flatMap((claim) =>
				claim && typeof claim === "object" && typeof claim.text === "string"
					? [claim.text]
					: [],
			);
			if (claims.length) return oneLine(claims.join(" "), NOTICE_RESULT_CHARS);
		}
	}
	return oneLine(JSON.stringify(result), NOTICE_RESULT_CHARS);
}

/** A finished, archived TODO as its notice tells it, with the screen of its toolchain when it has one. */
export function noticeOf(
	row: WorkRow,
	links: readonly WorkLink[],
	toolchainTitle: string | undefined,
	artifactId: string | undefined,
): TodoNotice {
	const names = new Map(links.map((link) => [link.uri, link.label]));
	return {
		id: row.id,
		conversationId: row.conversationId,
		title: row.title,
		...(toolchainTitle ? { toolchainTitle } : {}),
		...(artifactId ? { artifactId } : {}),
		outcome: row.outcome as TodoNotice["outcome"],
		summary:
			resultLine(row.result, (uri) => names.get(uri) ?? "リソース") ?? null,
		links: links.map(({ uri, label, kind }) => ({ uri, label, kind })),
		read: row.noticeReadAt !== null,
		createdAt: row.archivedAt!,
	};
}
