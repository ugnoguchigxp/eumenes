import {
	chromium,
	type Browser,
	type BrowserContext,
	type Page,
} from "@playwright/test";
import { scanReceipts } from "./host";
import { MAX_WAIT_SECONDS } from "./tester";
import type {
	AllowedSurface,
	FixtureDef,
	ObservedReceipt,
	TesterAction,
} from "./types";

/** Snapshot attempts per observation before the run stops as a driver error. */
const OBSERVE_ATTEMPTS = 3;
export const VIEWPORT = { width: 1280, height: 800 } as const;
export const LOCALE = "ja-JP";
export const TIMEZONE = "Asia/Tokyo";

type Observation = {
	snapshot: string;
	screenshot: Uint8Array;
	/** Runner clock right after the snapshot was taken, for aligning screen and host. */
	capturedAtMs: number;
};
type ActionResult = { ok: true } | { ok: false; code: string };

/**
 * The only way the runner touches the page for the tester: observe, and perform one of
 * click/fill/press/wait on an accessibility ref. There is no evaluate, no navigation to a
 * tester-chosen URL, and no request interception on the tester's behalf. The harness may
 * inject fixture faults; they are declared in the frozen fixture, not chosen by the tester.
 */
export type Driver = {
	readonly browserVersion: string;
	observe(): Promise<Observation>;
	perform(action: TesterAction, signal: AbortSignal): Promise<ActionResult>;
	receipts(): ObservedReceipt[];
	reloads(): number[];
	faultsTriggered(): Array<{ kind: string; atMs: number }>;
	/** The X-Request-Id of the latest write response, for step records. */
	lastWriteRequestId(): string | null;
	close(): Promise<void>;
};

const KEY = /^[A-Za-z0-9+_]{1,30}$/;
const RELOAD_KEYS = new Set([
	"F5",
	"Control+R",
	"Meta+R",
	"Control+Shift+R",
	"Meta+Shift+R",
]);
const sleep = (ms: number, signal: AbortSignal) =>
	new Promise<void>((resolve) => {
		const timer = setTimeout(resolve, ms);
		signal.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				resolve();
			},
			{ once: true },
		);
	});

function classify(error: unknown): string {
	const name = (error as Error)?.name;
	if (name === "TimeoutError") return "timeout";
	return "not_actionable";
}

export async function launchDriver(options: {
	startUrl: string;
	faults: FixtureDef["faults"];
	headed?: boolean;
	/** Per-operation timeout; refs that no longer exist fail after this long. */
	actionTimeoutMs?: number;
	/** The case's allowed surface; the UI-only surface refuses operations in the conversation. */
	surface?: AllowedSurface;
}): Promise<Driver> {
	const origin = new URL(options.startUrl).origin;
	const browser: Browser = await chromium.launch({ headless: !options.headed });
	const context: BrowserContext = await browser.newContext({
		viewport: VIEWPORT,
		deviceScaleFactor: 1,
		locale: LOCALE,
		timezoneId: TIMEZONE,
	});
	const page: Page = await context.newPage();
	page.setDefaultTimeout(options.actionTimeoutMs ?? 5000);
	const receipts: ObservedReceipt[] = [];
	const reloads: number[] = [];
	const faults: Array<{ kind: string; atMs: number }> = [];
	let loads = 0;
	let lastRequestId: string | null = null;
	let blockedNavigations = 0;

	// A real document load; history-API navigation inside the app is not a reload.
	page.on("load", () => {
		if (++loads > 1) reloads.push(Date.now());
	});
	page.on("response", (response) => {
		const url = new URL(response.url());
		if (url.origin !== origin || !url.pathname.startsWith("/api/")) return;
		const method = response.request().method();
		if (method !== "GET")
			lastRequestId = response.headers()["x-request-id"] ?? null;
		const type = response.headers()["content-type"] ?? "";
		if (!type.includes("application/json")) return;
		const atMs = Date.now();
		response
			.json()
			.then((body) =>
				receipts.push(...scanReceipts(body, atMs, response.status())),
			)
			.catch(() => {});
	});

	// The tester stays on the product's origin; leaving it is blocked, not followed.
	void context.route(
		(url) => url.origin !== origin,
		(route) => {
			if (!route.request().isNavigationRequest()) return route.continue();
			blockedNavigations++;
			return route.abort("blockedbyclient");
		},
	);

	const counters = new Map<number, number>();
	options.faults.forEach((fault, index) => {
		const pattern = new RegExp(fault.pathPattern);
		void context.route(
			(url) => url.origin === origin && pattern.test(url.pathname),
			async (route) => {
				if (route.request().method() !== fault.method) return route.continue();
				const seen = (counters.get(index) ?? 0) + 1;
				counters.set(index, seen);
				if (seen !== fault.nth) return route.continue();
				// The request reaches the server; the browser never sees the response.
				await route.fetch().catch(() => {});
				faults.push({ kind: fault.kind, atMs: Date.now() });
				await route.abort("connectionreset");
			},
		);
	});

	await page.goto(options.startUrl, { waitUntil: "load" });
	// A cold dev server may optimize dependencies and reload the page once; let it settle
	// before the first observation so the tester never sees a half-loaded screen.
	await page
		.waitForLoadState("networkidle", { timeout: 30_000 })
		.catch(() => {});

	const locate = (ref: string) => page.locator(`aria-ref=${ref}`);
	/** The harness boundary of the UI-only surface; the tester only learns it was refused. */
	/**
	 * The harness boundary of the UI-only surface. It fails closed: an element that cannot be
	 * resolved in time is refused rather than operated. The tester only learns the refusal.
	 */
	const outsideSurface = async (ref: string | undefined) => {
		if (options.surface !== "isolated-eumenes-artifacts" || !ref) return false;
		const target = await locate(ref)
			.elementHandle({ timeout: 5000 })
			.catch(() => null);
		if (!target) return true;
		try {
			return await target.evaluate((el) => {
				for (
					let node: Element | null = el as Element;
					node;
					node = node.parentElement
				) {
					const label = node.getAttribute("aria-label");
					const labelled = node.getAttribute("aria-labelledby");
					const name =
						label ??
						(labelled
							? document.getElementById(labelled)?.textContent?.trim()
							: null);
					if (
						name === "会話" &&
						(node.tagName === "SECTION" ||
							node.getAttribute("role") === "region")
					)
						return true;
				}
				return false;
			});
		} catch {
			return true;
		} finally {
			await target.dispose();
		}
	};
	return {
		browserVersion: browser.version(),
		async observe() {
			// Let a re-render settle so the refs in the snapshot match the live DOM. A busy page
			// (cold start, WebGL) can miss one snapshot deadline; that is retried, not judged.
			let snapshot = "";
			for (let attempt = 1; ; attempt++) {
				await page.waitForTimeout(300);
				try {
					snapshot = await page.ariaSnapshot({ mode: "ai", timeout: 15_000 });
					break;
				} catch (error) {
					if (attempt >= OBSERVE_ATTEMPTS) throw error;
					await page.waitForTimeout(1000);
				}
			}
			const capturedAtMs = Date.now();
			const screenshot = await page.screenshot({ type: "jpeg", quality: 70 });
			return { snapshot, screenshot, capturedAtMs };
		},
		async perform(action, signal) {
			const blockedBefore = blockedNavigations;
			if (
				["click", "fill", "press"].includes(action.action) &&
				(await outsideSurface(action.ref))
			)
				return { ok: false, code: "outside_allowed_surface" };
			let result: ActionResult;
			try {
				switch (action.action) {
					case "click":
						await locate(action.ref!).click({ noWaitAfter: true });
						break;
					case "fill":
						await locate(action.ref!).fill(action.text!);
						break;
					case "press":
						if (!KEY.test(action.text!))
							return { ok: false, code: "key_invalid" };
						// Headless Chromium ignores browser accelerators; reloading is the browser's own control.
						if (RELOAD_KEYS.has(action.text!))
							await page.reload({ waitUntil: "load" });
						else if (action.ref)
							await locate(action.ref).press(action.text!, {
								noWaitAfter: true,
							});
						else await page.keyboard.press(action.text!);
						break;
					case "wait":
						await sleep(
							Math.min(Number(action.text ?? "1"), MAX_WAIT_SECONDS) * 1000,
							signal,
						);
						return { ok: true };
					default:
						return { ok: false, code: "not_a_screen_operation" };
				}
				await sleep(300, signal);
				result = { ok: true };
			} catch (error) {
				result = { ok: false, code: classify(error) };
			}
			return blockedNavigations > blockedBefore
				? { ok: false, code: "blocked_external_navigation" }
				: result;
		},
		receipts: () => receipts,
		reloads: () => reloads,
		faultsTriggered: () => faults,
		lastWriteRequestId: () => lastRequestId,
		async close() {
			await context.close().catch(() => {});
			await browser.close().catch(() => {});
		},
	};
}
