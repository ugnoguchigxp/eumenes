import type { DriverTab } from "../contracts/ports";

/**
 * Parsing of `@playwright/mcp` 0.0.83 tool results. The text format belongs to that exact
 * version (pinned in package.json); adapters-mcp tests pin the shapes, so a version bump
 * must pass them. Nothing here logs or stores response text.
 */

export type McpContent =
	| { type: "text"; text: string }
	| { type: "image"; data: string; mimeType: string };

export type McpToolResult = { content?: McpContent[]; isError?: boolean };

export type McpSnapshotBody =
	| { kind: "inline"; text: string }
	/** Written by MCP into its output directory; only the file name is kept. */
	| { kind: "file"; name: string };

export type ParsedToolResult = {
	isError: boolean;
	/** `### Error` section text; present on failures. */
	error?: string;
	/** `### Result` section text (tab lists, evaluate output). */
	result?: string;
	page?: { url: string; title: string };
	snapshot?: McpSnapshotBody;
	images: { mimeType: string; data: string }[];
};

function parseSections(text: string): Map<string, string> {
	const sections = new Map<string, string>();
	for (const section of text.split(/^### /m).slice(1)) {
		const newline = section.indexOf("\n");
		if (newline === -1) continue;
		sections.set(section.slice(0, newline), section.slice(newline + 1).trim());
	}
	return sections;
}

/**
 * The closing fence of an inline snapshot: a line of three backticks that ends the text or is followed by the
 * next section header. The snapshot is page text, so it may contain such lines itself; the real fence is the
 * last one, because everything MCP writes after the snapshot is made of host sections only.
 */
const FENCE_END = /\n```[ \t]*(?=\n### |\s*$)/g;
const SNAPSHOT_LINK = /\[Snapshot\]\(([^)\n]+)\)/;

/**
 * The snapshot is cut out first: it carries page text, so it must not be split on `### `.
 * Returns the snapshot and the remaining text for section parsing.
 */
function extractSnapshot(text: string): {
	rest: string;
	snapshot?: McpSnapshotBody;
} {
	const header = /^### Snapshot\n/m.exec(text);
	if (!header) return { rest: text };
	const before = text.slice(0, header.index);
	const after = text.slice(header.index + header[0].length);
	if (after.startsWith("```yaml\n")) {
		const body = `\n${after.slice("```yaml\n".length)}`;
		const end = [...body.matchAll(FENCE_END)].at(-1);
		if (!end) return { rest: before };
		return {
			rest: `${before}${body.slice(end.index + end[0].length)}`,
			snapshot: { kind: "inline", text: body.slice(1, end.index) },
		};
	}
	const nextHeader = after.search(/^### /m);
	const section = nextHeader === -1 ? after : after.slice(0, nextHeader);
	const rest = `${before}${nextHeader === -1 ? "" : after.slice(nextHeader)}`;
	const link = SNAPSHOT_LINK.exec(section);
	const name = link?.[1] ? linkFileName(link[1]) : undefined;
	return name ? { rest, snapshot: { kind: "file", name } } : { rest };
}

/** Only the base name is trusted: links are relative to MCP's workspace or absolute. */
export function linkFileName(link: string): string | undefined {
	if (link.includes("\0")) return undefined;
	const name = link.split(/[\\/]/).pop();
	return name && name !== "." && name !== ".." ? name : undefined;
}

function parsePage(section: string | undefined) {
	if (!section) return undefined;
	const url = /^- Page URL: (.*)$/m.exec(section)?.[1];
	if (url === undefined) return undefined;
	return { url, title: /^- Page Title: (.*)$/m.exec(section)?.[1] ?? "" };
}

export function parseToolResult(raw: McpToolResult): ParsedToolResult {
	const content = raw.content ?? [];
	const first = content[0];
	const text = first?.type === "text" ? first.text : "";
	const { rest, snapshot } = extractSnapshot(text);
	const sections = parseSections(rest);
	return {
		isError: raw.isError === true || sections.has("Error"),
		error: sections.get("Error"),
		result: sections.get("Result"),
		page: parsePage(sections.get("Page")),
		snapshot,
		images: content.flatMap((item) =>
			item.type === "image"
				? [{ mimeType: item.mimeType, data: item.data }]
				: [],
		),
	};
}

const TAB_LINE = /^- (\d+):( \(current\))? \[(.*)\]\((.*)\)(?: \[crashed\])?$/;

/** `- 1: (current) [Title](url)` lines; `null` when the section is not a tab list. */
export function parseTabList(result: string | undefined): DriverTab[] | null {
	if (result === undefined) return null;
	if (result.startsWith("No open tabs")) return [];
	const tabs: DriverTab[] = [];
	for (const line of result.split("\n")) {
		const match = TAB_LINE.exec(line.trimEnd());
		if (!match) return null;
		tabs.push({
			index: Number(match[1]),
			title: match[3] ?? "",
			url: match[4] ?? "",
			current: match[2] !== undefined,
		});
	}
	return tabs;
}

export type ToolFailure = { code: string; dispatched: boolean };

/** MCP tools whose failure can change nothing on the page. */
const NO_EFFECT_TOOLS = new Set(["browser_hover", "browser_wait_for"]);
/** MCP tools that load a page; a navigation error before any response means the page never changed. */
const NAVIGATION_TOOLS = new Set(["browser_navigate", "browser_navigate_back"]);
/** Playwright's call log says the pointer action itself started (`performing click action`, `click action done`). */
const ACTION_STARTED = /performing .+ action|\b\w+ action done\b/i;
/** ... or that it was still waiting to be allowed to start (retry lines of the actionability loop). */
const STILL_GATED =
	/element is not (?:visible|enabled|editable|stable|attached)|element is outside of the viewport|intercepts pointer events|did not find some options|option being selected is not enabled/i;

/**
 * Stable, non-textual classification of a `### Error` body. The text itself is never kept. `dispatched`
 * is true only when the action may have reached the page, which is what makes an operation indeterminate:
 * failures that provably happened before anything was performed (a ref that is not there, a click that never
 * got past Playwright's actionability wait, a name that did not resolve) are not.
 */
export function classifyToolError(
	error: string | undefined,
	tool?: string,
): ToolFailure {
	const text = error ?? "";
	if (/not found in the current page snapshot/.test(text))
		return { code: "ref_not_found", dispatched: false };
	if (
		/browser has been closed|extension disconnected|extension not connected|playwright client disconnected/i.test(
			text,
		)
	)
		return { code: "browser_closed", dispatched: true };
	if (/strict mode violation/i.test(text))
		return { code: "ref_ambiguous", dispatched: false };
	if (/Element is not a <select> element/i.test(text))
		return { code: "element_not_select", dispatched: false };
	const timeout = /Timeout \d+ms exceeded/.test(text);
	if (tool && NO_EFFECT_TOOLS.has(tool))
		return {
			code: timeout ? "action_timeout" : "mcp_error",
			dispatched: false,
		};
	if (tool && NAVIGATION_TOOLS.has(tool)) {
		if (/net::ERR_[A-Z_]+/.test(text))
			return { code: "navigation_failed", dispatched: false };
		if (/cannot go back|no (?:previous|history)/i.test(text))
			return { code: "navigation_failed", dispatched: false };
		if (timeout) return { code: "navigation_timeout", dispatched: true };
	}
	if (timeout) {
		// Without a call log there is nothing to prove the action never ran.
		if (!/Call log:/.test(text) || ACTION_STARTED.test(text))
			return { code: "action_timeout", dispatched: true };
		return {
			code: "action_timeout",
			dispatched: !(tool === "browser_click" || STILL_GATED.test(text)),
		};
	}
	return { code: "mcp_error", dispatched: true };
}
