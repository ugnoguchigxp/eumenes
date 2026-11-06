import type {
	BrowserDriver,
	CaptureRange,
	DriverAction,
	DriverDisconnectReason,
	TargetInfo,
} from "../contracts/ports";
import { BrowserDriverError } from "../contracts/ports";
import { interactTextFunction, parseInteractText } from "./interact-text";
import { runUntilStopped } from "./mcp-replay";
import { parseTabList, type ParsedToolResult } from "./mcp-response";
import { type McpSession } from "./mcp-session";

export const ALLOWED_MCP_TOOLS = [
	"browser_tabs",
	"browser_navigate",
	"browser_navigate_back",
	"browser_snapshot",
	"browser_click",
	"browser_hover",
	"browser_type",
	"browser_select_option",
	"browser_press_key",
	"browser_wait_for",
	"browser_take_screenshot",
	"browser_evaluate",
	"browser_run_code_unsafe",
] as const;
export type ToolName = (typeof ALLOWED_MCP_TOOLS)[number];

/** Fixed measuring functions. No input is ever interpolated into them. */
const MEASURE_PAGE_FUNCTION =
	"() => { const d = document.documentElement; const b = document.body; return { viewportWidth: window.innerWidth, viewportHeight: window.innerHeight, scrollWidth: Math.max(d.scrollWidth, b ? b.scrollWidth : 0), scrollHeight: Math.max(d.scrollHeight, b ? b.scrollHeight : 0), devicePixelRatio: window.devicePixelRatio }; }";
const MEASURE_ELEMENT_FUNCTION =
	"(element) => { const r = element.getBoundingClientRect(); return { width: r.width, height: r.height, devicePixelRatio: window.devicePixelRatio }; }";

/**
 * Fixed inspection of the element an operation would act on: what the HTML says it does (spec §5.3). The
 * function reads attributes and form membership only; no input is ever interpolated into it.
 */
const INSPECT_ELEMENT_BODY = `(el) => {
  const method = (v) => { const s = String(v || '').toLowerCase(); return s === 'get' || s === 'post' || s === 'dialog' ? s : ''; };
  const textual = ['text', 'search', 'url', 'tel', 'email', 'password', 'date', 'month', 'week', 'time', 'datetime-local', 'number'];
  if (!el || el === document.body || el === document.documentElement) return { tag: 'body', inForm: false, submits: false };
  const tag = el.tagName.toLowerCase();
  const type = tag === 'input' || tag === 'button' ? String(el.type || '').toLowerCase() : '';
  const typed = type ? { type } : {};
  const role = String(el.getAttribute('role') || '').trim().toLowerCase() === 'button' ? { role: 'button' } : {};
  const raw = tag === 'a' || tag === 'area' ? el.getAttribute('href') : undefined;
  const link = raw === undefined ? {} : { href: raw === null ? null : String(raw).slice(0, 200) };
  const form = el.form || el.closest('form');
  if (!form) return { tag, ...typed, ...role, ...link, inForm: false, submits: false };
  const own = tag === 'input' || tag === 'button' ? method(el.getAttribute('formmethod')) : '';
  const formMethod = own || method(form.method) || 'get';
  const fields = Array.from(form.elements);
  const isSubmitter = (n) => (n.tagName === 'BUTTON' && n.type === 'submit') || (n.tagName === 'INPUT' && (n.type === 'submit' || n.type === 'image'));
  const isTextField = (n) => n.tagName === 'INPUT' && textual.includes(n.type);
  let submits = false;
  if (isSubmitter(el)) submits = true;
  else if (isTextField(el)) submits = fields.some(isSubmitter) || fields.filter(isTextField).length === 1;
  return { tag, ...typed, ...role, ...link, inForm: true, formMethod, submits };
}`;
const INSPECT_TARGET_FUNCTION = INSPECT_ELEMENT_BODY;
const INSPECT_FOCUSED_FUNCTION = `() => (${INSPECT_ELEMENT_BODY})(document.activeElement)`;

/** Element refs from `[ref=eN]` (optionally frame-prefixed `f1e3`). Anything else would be a selector. */
const REF = /^(?:f\d+)?e\d+$/;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

type CallTool = (
	name: ToolName,
	args: Record<string, unknown>,
	signal?: AbortSignal,
) => Promise<ParsedToolResult>;

/** The tabs the child lists (its own extension pages left out), through the given way of calling it. */
export async function tabsVia(call: CallTool, args: Record<string, unknown>) {
	const parsed = await call("browser_tabs", args);
	const tabs = parseTabList(parsed.result);
	if (!tabs) throw new BrowserDriverError("mcp_response_unrecognized", true);
	return tabs.filter((tab) => !tab.url.startsWith("chrome-extension:"));
}

/**
 * `runReplay`: the code tool through `runUntilStopped`, which holds the serial section for the whole run, so the
 * calls it makes itself (the tab list, the tab close) go around the serial queue.
 */
export function createReplayRunner(deps: {
	serial: <T>(
		signal: AbortSignal | undefined,
		run: () => Promise<T>,
	) => Promise<T>;
	call: (
		name: ToolName,
		args: Record<string, unknown>,
		signal?: AbortSignal,
		readSnapshotFile?: boolean,
		closing?: () => boolean,
	) => Promise<ParsedToolResult>;
	connectedSession: () => McpSession | undefined;
	end: (child: McpSession, reason: DriverDisconnectReason) => Promise<void>;
	stopGraceMs: number;
}): BrowserDriver["runReplay"] {
	return (code, signal) =>
		deps.serial(signal, async () => {
			const child = deps.connectedSession();
			if (!child) throw new BrowserDriverError("not_connected", false);
			await runUntilStopped({
				currentTab: () =>
					tabsVia(deps.call, { action: "list" })
						.then((tabs) => tabs.find((t) => t.current)?.index)
						.catch(() => undefined),
				run: (closing) =>
					deps.call(
						"browser_run_code_unsafe",
						{ code },
						undefined,
						false,
						closing,
					),
				closeTab: (index) =>
					tabsVia(deps.call, { action: "close", index: tabIndex(index) }),
				endSession: () => deps.end(child, "process_exited"),
				graceMs: deps.stopGraceMs,
				signal,
			});
		});
}

/**
 * The calls that read the page without changing it: the host's fixed inspection and measuring functions
 * (the only users of `browser_evaluate`) and the screenshot.
 */
export function createReaders(
	callTool: CallTool,
): Pick<
	BrowserDriver,
	"inspectTarget" | "inspectFocused" | "measure" | "screenshot" | "readText"
> {
	/** Inspection only reads attributes, so whatever goes wrong never reached the page's state. */
	const inspectCall = async (args: Record<string, unknown>) => {
		try {
			return (await callTool("browser_evaluate", args)).result;
		} catch (error) {
			throw new BrowserDriverError(toDriverError(error).code, false);
		}
	};
	return {
		async readText(ref, maxChars, signal) {
			if (!Number.isSafeInteger(maxChars) || maxChars < 100 || maxChars > 50000)
				throw new BrowserDriverError("extraction_limit_invalid", false);
			const body = interactTextFunction(maxChars);
			const parsed = await callTool(
				"browser_evaluate",
				ref
					? { function: body, target: refOf(ref), element: "read content" }
					: { function: `() => (${body})(null)` },
				signal,
			);
			return parseInteractText(parsed.result, maxChars);
		},
		async inspectTarget(ref) {
			return inspected(
				await inspectCall({
					function: INSPECT_TARGET_FUNCTION,
					target: refOf(ref),
					element: "inspected element",
				}),
			);
		},
		inspectFocused: async () =>
			inspected(await inspectCall({ function: INSPECT_FOCUSED_FUNCTION })),
		async measure(range, elementRef) {
			const args =
				range === "element"
					? {
							function: MEASURE_ELEMENT_FUNCTION,
							target: refOf(elementRef),
							element: "measured element",
						}
					: { function: MEASURE_PAGE_FUNCTION };
			const parsed = await callTool("browser_evaluate", args);
			return measured(range, parsed.result);
		},
		async screenshot(range, elementRef, signal) {
			const args: Record<string, unknown> = { type: "png", scale: "css" };
			if (range === "full-page") args.fullPage = true;
			if (range === "element") {
				args.target = refOf(elementRef);
				args.element = "captured element";
			}
			const parsed = await callTool("browser_take_screenshot", args, signal);
			const image = parsed.images.find((item) => item.mimeType === "image/png");
			if (!image) throw new BrowserDriverError("screenshot_missing", true);
			const bytes = new Uint8Array(Buffer.from(image.data, "base64"));
			if (!PNG_SIGNATURE.every((byte, i) => bytes[i] === byte))
				throw new BrowserDriverError("screenshot_invalid", true);
			return bytes;
		},
	};
}

export function toDriverError(error: unknown): BrowserDriverError {
	return error instanceof BrowserDriverError
		? error
		: new BrowserDriverError("mcp_unavailable", true);
}

export function refOf(ref: string | undefined): string {
	if (ref === undefined || !REF.test(ref))
		throw new BrowserDriverError("invalid_ref", false);
	return ref;
}

export function tabIndex(index: number): number {
	if (!Number.isInteger(index) || index < 0)
		throw new BrowserDriverError("invalid_tab_index", false);
	return index;
}

/** Defence in depth: the domain decides destinations; the adapter never sends other schemes. */
export function webUrl(url: string): string {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new BrowserDriverError("invalid_url", false);
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
		throw new BrowserDriverError("invalid_url", false);
	return url;
}

export function actionCall(
	action: DriverAction,
): [ToolName, Record<string, unknown>] {
	switch (action.kind) {
		case "navigate":
			return ["browser_navigate", { url: webUrl(action.url) }];
		case "back":
			return ["browser_navigate_back", {}];
		case "click":
			return [
				"browser_click",
				{ target: refOf(action.ref), element: action.element },
			];
		case "hover":
			return [
				"browser_hover",
				{ target: refOf(action.ref), element: action.element },
			];
		case "type":
			return [
				"browser_type",
				{
					target: refOf(action.ref),
					element: action.element,
					text: action.text,
					submit: action.submit,
				},
			];
		case "select":
			return [
				"browser_select_option",
				{
					target: refOf(action.ref),
					element: action.element,
					values: action.values,
				},
			];
		case "press":
			return ["browser_press_key", { key: action.key }];
		case "wait": {
			const args: Record<string, unknown> = {};
			if (action.text !== undefined) args.text = action.text;
			if (action.textGone !== undefined) args.textGone = action.textGone;
			if (action.seconds !== undefined) {
				if (!Number.isFinite(action.seconds) || action.seconds < 0)
					throw new BrowserDriverError("invalid_wait", false);
				args.time = action.seconds;
			}
			if (Object.keys(args).length === 0)
				throw new BrowserDriverError("invalid_wait", false);
			return ["browser_wait_for", args];
		}
		default:
			throw new BrowserDriverError("action_not_supported", false);
	}
}

/** The JSON object an evaluate call returned (MCP wraps it in a fence). */
function evaluated(result: string | undefined, code: string) {
	let value: unknown;
	try {
		value = JSON.parse(
			(result ?? "").replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, ""),
		);
	} catch {
		throw new BrowserDriverError(code, false);
	}
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new BrowserDriverError(code, false);
	return value as Record<string, unknown>;
}

function inspected(result: string | undefined): TargetInfo {
	const value = evaluated(result, "inspect_invalid");
	const { tag, type, inForm, formMethod, submits, role, href } = value;
	if (
		typeof tag !== "string" ||
		tag.length > 40 ||
		typeof inForm !== "boolean" ||
		typeof submits !== "boolean" ||
		(type !== undefined && (typeof type !== "string" || type.length > 40)) ||
		(formMethod !== undefined &&
			(typeof formMethod !== "string" || formMethod.length > 20)) ||
		(role !== undefined && role !== "button") ||
		(href !== undefined &&
			href !== null &&
			(typeof href !== "string" || href.length > 200))
	)
		throw new BrowserDriverError("inspect_invalid", false);
	return {
		tag,
		...(type !== undefined ? { type } : {}),
		...(role === "button" ? { role } : {}),
		...(href !== undefined ? { href: href as string | null } : {}),
		inForm,
		...(formMethod !== undefined ? { formMethod } : {}),
		submits,
	};
}

function measured(range: CaptureRange, result: string | undefined) {
	const value = evaluated(result, "measure_invalid");
	const dpr = value.devicePixelRatio;
	const devicePixelRatio =
		typeof dpr === "number" && Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
	if (range === "element")
		return {
			width: positive(value.width),
			height: positive(value.height),
			devicePixelRatio,
		};
	if (range === "viewport")
		return {
			width: positive(value.viewportWidth),
			height: positive(value.viewportHeight),
			devicePixelRatio,
		};
	return {
		width: Math.max(positive(value.scrollWidth), positive(value.viewportWidth)),
		height: Math.max(
			positive(value.scrollHeight),
			positive(value.viewportHeight),
		),
		devicePixelRatio,
	};
}

function positive(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
		throw new BrowserDriverError("measure_invalid", false);
	return Math.ceil(value);
}
