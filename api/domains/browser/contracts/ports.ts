/**
 * Ports the browser domain owns and `adapters/` implements
 * (spec/browser-tabs-toolchain-design-2026-10-18.md). The adapter drives the user's own Brave
 * through a child `@playwright/mcp --extension` and the Playwright MCP Bridge extension.
 * The domain never sees MCP, tool names or response text; it only sees these shapes.
 * All calls run outside the writer transaction, and the domain serialises them: one call at a
 * time per connection, because the MCP session acts on a single "current tab".
 */

export type CaptureRange = "viewport" | "full-page" | "element";

export type DriverConnectionState =
	| { state: "disconnected"; reason?: DriverDisconnectReason }
	| { state: "connecting"; startedAt: string }
	| { state: "connected"; connectedAt: string };

export type DriverDisconnectReason =
	| "user"
	| "browser_closed"
	| "process_exited"
	| "connect_timeout"
	| "not_configured"
	| "mcp_unavailable";

/** A tab as the MCP session lists it. `index` shifts when tabs close; match on url/title too. */
export type DriverTab = {
	index: number;
	url: string;
	title: string;
	current: boolean;
};

export type DriverSnapshot = {
	url: string;
	title: string;
	/** The whole ARIA snapshot text with `[ref=eN]` markers, as MCP returned it (memory only). */
	snapshot: string;
};

/** One page operation on the current tab; `ref` values come from the latest snapshot of it. */
export type DriverAction =
	| { kind: "navigate"; url: string }
	| { kind: "back" }
	| { kind: "click"; ref: string; element: string }
	| { kind: "hover"; ref: string; element: string }
	| {
			kind: "type";
			ref: string;
			element: string;
			text: string;
			submit: boolean;
	  }
	| { kind: "select"; ref: string; element: string; values: string[] }
	| { kind: "press"; key: string }
	| { kind: "wait"; text?: string; textGone?: string; seconds?: number };

export type DriverActionResult =
	| {
			ok: true;
			url: string;
			title: string;
			/** The Playwright code MCP reported running (`### Ran Playwright code`), when it did. */
			code?: string;
	  }
	/** `dispatched: true` means the action may have reached the page (→ indeterminate). */
	| { ok: false; code: string; dispatched: boolean };

export type PlannedSize = { width: number; height: number };

/**
 * What the HTML says about the element an operation would act on, read by a fixed host function (no model
 * input in it). `submits` means clicking it, or pressing Enter in it, would submit its form;
 * `formMethod` is that form's effective method (`get`, `post` or `dialog`).
 */
export type TargetInfo = {
	tag: string;
	type?: string;
	inForm: boolean;
	formMethod?: string;
	submits: boolean;
};

/** The addresses a host name resolves to (loopback and private ones are what the domain looks for). */
export type HostResolver = (hostname: string) => Promise<string[]>;

/** Thrown by every driver call except `act`, which returns its failure instead. */
export class BrowserDriverError extends Error {
	constructor(
		readonly code: string,
		/** The call may have reached the page (callers treat it as indeterminate). */
		readonly dispatched: boolean,
	) {
		super(code);
		this.name = "BrowserDriverError";
	}
}

export interface BrowserDriver {
	/**
	 * Start the MCP child and wait until the user picks a tab in Brave's connect page.
	 * Resolves when connected, or with the disconnect reason (e.g. `connect_timeout`).
	 */
	connect(signal: AbortSignal): Promise<DriverConnectionState>;
	/** Stop the MCP child; the user's browser and tabs stay as they are. */
	disconnect(): Promise<void>;
	state(): DriverConnectionState;
	/** Called once per state change (connected, browser closed, child exited). */
	onStateChange(listener: (state: DriverConnectionState) => void): () => void;
	listTabs(): Promise<DriverTab[]>;
	selectTab(index: number): Promise<DriverTab[]>;
	newTab(url: string): Promise<DriverTab[]>;
	closeTab(index: number): Promise<DriverTab[]>;
	/** Snapshot of the current tab. */
	snapshot(signal: AbortSignal): Promise<DriverSnapshot>;
	act(action: DriverAction, signal: AbortSignal): Promise<DriverActionResult>;
	/**
	 * Runs the code of a replay on the current tab (MCP's `browser_run_code_unsafe`). The host has checked the code;
	 * nothing of the response is returned or kept. Failure is thrown; a failure may have reached the page.
	 */
	runReplay(code: string, signal: AbortSignal): Promise<void>;
	/** Inspects the element of an observed ref on the current tab. Read-only: a failure never reached the page. */
	inspectTarget(ref: string): Promise<TargetInfo>;
	/** Inspects the focused element of the current tab (what a key press would act on). Read-only. */
	inspectFocused(): Promise<TargetInfo>;
	/** Planned CSS-pixel size of a capture of the current tab, measured by a fixed host function. */
	measure(
		range: CaptureRange,
		elementRef?: string,
	): Promise<PlannedSize & { devicePixelRatio: number }>;
	/** PNG bytes of the current tab; the domain re-checks the PNG header size before decoding. */
	screenshot(
		range: CaptureRange,
		elementRef: string | undefined,
		signal: AbortSignal,
	): Promise<Uint8Array>;
}

export type EncodedWebp = {
	bytes: Uint8Array;
	width: number;
	height: number;
	sha256: string;
};

export interface ImageEncoder {
	/** Width/height from the PNG header without decoding pixels. */
	pngSize(png: Uint8Array): PlannedSize;
	/** Lossy WebP, quality 75 fixed by the implementation; no input can change it. */
	encodeWebp(png: Uint8Array, signal: AbortSignal): Promise<EncodedWebp>;
	/** Decode check: lossy WebP (VP8), dimensions, sha256. */
	inspectWebp(bytes: Uint8Array): Promise<EncodedWebp & { lossy: boolean }>;
}

/** Files under the domain's managed directory, addressed by relative refs only. */
export interface CaptureFiles {
	/** Write to a temporary name; returns the temp ref. */
	writeTemp(captureId: string, bytes: Uint8Array): Promise<string>;
	/** Rename a checked temp file to its final ref (derived from the capture id only). */
	adopt(tempRef: string, captureId: string): Promise<string>;
	read(ref: string): Promise<Uint8Array>;
	remove(ref: string): Promise<void>;
	/** Temp files not adopted; the domain removes those with no DB row. */
	listTemp(): Promise<string[]>;
	/** Adopted files (`<captureId>.webp`); the domain removes those no capture row points at. */
	listAdopted(): Promise<string[]>;
}

/** The OS file dialog for choosing Brave; null when the user cancels. It only reads a path, never launches it. */
export type ExecutablePicker = () => Promise<string | null>;
