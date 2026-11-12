import {
	parseToolResult as parsePlaywrightToolResult,
	type McpToolResult,
	type ParsedToolResult as PlaywrightToolResult,
} from "eumenes-interact/adapters/playwright-mcp/response";

export {
	linkFileName,
	parseTabList,
} from "eumenes-interact/adapters/playwright-mcp/response";
export type {
	McpContent,
	McpSnapshotBody,
	McpToolResult,
} from "eumenes-interact/adapters/playwright-mcp/response";

export type ParsedToolResult = Omit<PlaywrightToolResult, "page"> & {
	page?: { url: string; title: string };
};

export function parseToolResult(raw: McpToolResult): ParsedToolResult {
	const parsed = parsePlaywrightToolResult(raw);
	return {
		...parsed,
		page: parsed.page && { ...parsed.page, title: parsed.page.title ?? "" },
		code: parsed.code,
	};
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
