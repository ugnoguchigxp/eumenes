import { getLogger } from "../../../infrastructure/logger";
import type { Lease } from "./profiles";
import type { Control } from "./connect";
const log = getLogger("larm");
export function stopUsing(current: Lease) {
	current.closing = true;
	clearTimeout(current.renewTimer);
	clearTimeout(current.idleTimer);
}

/** One terminal DELETE, even when recovery and the final borrower both clean up. */
export async function releaseConnection(current: Lease, control: Control) {
	if (current.release) return current.release;
	current.release = control(
		`/v1/agent-connections/${encodeURIComponent(current.id)}`,
		{ method: "DELETE" },
		[204, 200, 404, 410],
	)
		.then((response) => {
			// The status confirms deletion; body cleanup must not hold up reconnection.
			void response.body?.cancel().catch(() => {});
			try {
				log.info("larm.connection_released", {
					connectionId: current.id,
					status: response.status,
				});
			} catch {
				/* Observation does not invalidate a confirmed release. */
			}
		})
		.catch((error: unknown) => {
			current.release = undefined;
			throw error;
		});
	return current.release;
}
