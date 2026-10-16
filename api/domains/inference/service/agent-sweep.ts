import type { SqliteStore } from "../../../infrastructure/sqlite";
import { getLogger } from "../../../infrastructure/logger";
import { sweepClaudeTemp } from "../adapters/claude-session";
import { sweepTaskSessions } from "./agent-session";

const log = getLogger("inference");
const AGENT_SWEEP_INTERVAL_MS = 60 * 60_000;

/**
 * Collects what agent calls leave behind: task sessions nobody released (an attempt that outlived its task can
 * write its row again after the release) and the temporary directories a crashed or killed call left. It runs
 * at start and then on a timer, so a long-running host does not wait for a restart.
 */
export function createAgentSweeper(
	store: SqliteStore,
	intervalMs = AGENT_SWEEP_INTERVAL_MS,
) {
	let timer: ReturnType<typeof setInterval> | undefined;
	const run = async () => {
		await sweepTaskSessions(store);
		await sweepClaudeTemp();
	};
	return {
		run,
		/** Sweeps once (errors reach the caller), then keeps sweeping; idempotent. */
		async start() {
			await run();
			if (timer) return;
			timer = setInterval(() => {
				run().catch((error) =>
					log.warn("inference.agent_sweep_failed", {
						reason: error instanceof Error ? error.name : "unknown",
					}),
				);
			}, intervalMs);
			timer.unref();
		},
		stop() {
			if (timer) clearInterval(timer);
			timer = undefined;
		},
	};
}
