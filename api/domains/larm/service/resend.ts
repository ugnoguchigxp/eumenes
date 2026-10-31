import { readBounded } from "../../../infrastructure/bounded-read";
import { getLogger } from "../../../infrastructure/logger";
import {
	LARM_CAPACITY_BUSY,
	LARM_CAPACITY_REFUSAL,
	LARM_RETRY_AFTER_LIMIT_MS,
} from "../contracts/capacity";

/**
 * The only place an on-demand request to LARM is sent again. Three rules:
 * - capacity: LARM had no free memory; the owning domain schedules the same request later;
 * - not ready: the same connection is claimed again while LARM is still starting its provider;
 * - lost response: no answer arrived, so the same Idempotency-Key is sent once more.
 * Anything else is not sent again.
 */
const log = getLogger("larm");

/** LARM refused for lack of free memory before accepting the request. */
export class LarmCapacityBusy extends Error {
	constructor(readonly retryAfterMs: number | null) {
		super(LARM_CAPACITY_BUSY);
	}
}
export const isCapacityBusy = (e: unknown): e is LarmCapacityBusy =>
	e instanceof LarmCapacityBusy;

function retryAfter(headers: Headers) {
	const value = headers.get("retry-after")?.trim();
	if (!value) return null;
	const ms = /^\d+$/.test(value)
		? Number(value) * 1000
		: Date.parse(value) - Date.now();
	return Number.isFinite(ms) && ms > 0
		? Math.min(ms, LARM_RETRY_AFTER_LIMIT_MS)
		: null;
}
const field = (value: unknown, key: string) =>
	value && typeof value === "object" && key in value
		? (value as Record<string, unknown>)[key]
		: undefined;
/** LARM's own code and resource from `{error}`, `{error:{code,resource}}` or `{code,resource}`. */
function explained(body: unknown) {
	const error = field(body, "error");
	const code =
		typeof error === "string"
			? error
			: (field(error, "code") ?? field(body, "code"));
	const resource = field(error, "resource") ?? field(body, "resource");
	return {
		code: typeof code === "string" ? code : null,
		resource: typeof resource === "string" ? resource : null,
	};
}
/** Only a short identifier is logged; LARM's message and body never are. */
const logged = (code: string | null) =>
	code && /^[a-z][a-z0-9_]{0,63}$/.test(code) ? code : "unknown";
const route = (path: string) =>
	path
		.split("?")[0]!
		.replace(/\/[A-Za-z0-9_-]*(?:\d[A-Za-z0-9_-]*){4,}/g, "/:id");

/** The capacity refusal of an already read body, or `null` for any other answer. */
export function capacityRefusal(
	status: number,
	body: unknown,
	headers: Headers,
	path: string,
) {
	const { code, resource } = explained(body);
	if (
		status !== LARM_CAPACITY_REFUSAL.status ||
		code !== LARM_CAPACITY_REFUSAL.code ||
		resource !== LARM_CAPACITY_REFUSAL.resource
	)
		return null;
	const busy = new LarmCapacityBusy(retryAfter(headers));
	log.info("larm.capacity_refused", {
		route: route(path),
		status,
		larmCode: code,
		retryAfterMs: busy.retryAfterMs ?? undefined,
	});
	return busy;
}

/**
 * Reads a refused response (at most 16 KiB within 1 s). For a request that asks LARM to accept work
 * (`waitable`), a capacity refusal is thrown as {@link LarmCapacityBusy}. Any other refusal, and every
 * refusal of a read, renewal or release, is logged with its code and left to the caller.
 */
export async function checkRefusal(
	response: Response,
	path: string,
	waitable: boolean,
) {
	let body: unknown = null;
	try {
		const bytes = await readBounded(response.body, {
			limit: 16 * 1024,
			missing: "invalid_provider_response",
			tooLarge: "response_too_large",
			signal: AbortSignal.timeout(1000),
		});
		body = JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		await response.body?.cancel().catch(() => {});
	}
	const busy =
		waitable && capacityRefusal(response.status, body, response.headers, path);
	if (busy) throw busy;
	log.info("larm.refused", {
		route: route(path),
		status: response.status,
		larmCode: logged(explained(body).code),
	});
}

/**
 * The lost-response rule: one more send, with the same Idempotency-Key, when no answer arrived. If that
 * send is refused for memory, the first may still have been accepted, so the loss is reported instead
 * of a wait.
 */
export async function sendAgainIfLost<T>(send: () => Promise<T>) {
	try {
		return await send();
	} catch (error) {
		if (
			!(
				error instanceof TypeError ||
				(error instanceof DOMException && error.name === "TimeoutError")
			)
		)
			throw error;
		return await send().catch((again: unknown) => {
			throw isCapacityBusy(again) ? error : again;
		});
	}
}

/** The not-ready rule: `attempt` claims the same connection again after each `between`; null is "not yet". */
export async function claimWhenReady<T>(
	attempt: () => Promise<T | null>,
	between: () => Promise<void>,
): Promise<T> {
	for (;;) {
		const value = await attempt();
		if (value !== null) return value;
		await between();
	}
}
