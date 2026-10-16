import { getLogger } from "../../../infrastructure/logger";
import type { Fetcher } from "./profiles";

const log = getLogger("larm");
/** Budget of a control request: POSTs (create, claim, renew) may wait on LARM this long. */
const CONTROL_TIMEOUT_MS = 15_000;
/** Read-only status checks made for a caller must answer quickly. */
const STATUS_CHECK_TIMEOUT_MS = 3_000;

/** The authenticated control-plane request of one port; it never leaves the control origin. */
export function createControl({
	base,
	token,
	request,
	lifetime,
}: {
	base: URL | undefined;
	token: string | undefined;
	request: Fetcher;
	/** Aborted when the port closes: every control request ends with it. */
	lifetime: AbortSignal;
}) {
	return async function control(
		path: string,
		init: RequestInit,
		accepted: number[],
	): Promise<Response> {
		if (!base) throw new Error("larm_base_url_unconfigured");
		if (!token) throw new Error("larm_unconfigured");
		const url = new URL(path, base);
		if (url.origin !== base.origin)
			throw new Error("larm_control_origin_mismatch");
		const response = await request(url, {
			...init,
			headers: { Authorization: `Bearer ${token}`, ...init.headers },
			redirect: "error",
			signal:
				init.method === "DELETE"
					? AbortSignal.timeout(CONTROL_TIMEOUT_MS)
					: AbortSignal.any([
							lifetime,
							// Only read-only status checks made for a caller are short. POSTs
							// (create, claim, renew) may legitimately wait on LARM, so they keep
							// the full control budget instead of the status-check one; the
							// caller's signal and the lifetime still end them.
							AbortSignal.timeout(
								(!init.method || init.method === "GET") && init.signal
									? STATUS_CHECK_TIMEOUT_MS
									: CONTROL_TIMEOUT_MS,
							),
							...(init.signal ? [init.signal] : []),
						]),
		});
		if (!accepted.includes(response.status)) {
			log.warn("larm.control_rejected", {
				route: path
					.split("?")[0]!
					.replace(/(agent-connections\/)[^/]+/, "$1:id"),
				method: init.method ?? "GET",
				status: response.status,
			});
			throw new Error(`larm_control_${response.status}`);
		}
		return response;
	};
}
