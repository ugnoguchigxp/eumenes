import type { StopObservation } from "../contracts/visual-perception";
import type { VisualControl } from "./visual-claim";
import { json, list, pause } from "./playground-http";
/** Read-only snapshot observation. Never acquires a connection or gates the next analysis. */
export async function observeVisualStop(
	control: VisualControl,
	initial: StopObservation,
	options: { timeoutMs?: number; pollMs?: number } = {},
): Promise<StopObservation> {
	const signal = AbortSignal.timeout(options.timeoutMs ?? 30000);
	let result = { ...initial };
	const unconfirmed = (reason: StopObservation["reason"]): StopObservation => ({
		...result,
		status: "unconfirmed",
		reason,
		checkedAt: Date.now(),
	});
	try {
		const connection = await json(
			await control(
				`/v1/agent-connections/${encodeURIComponent(initial.connectionId)}`,
				signal,
				{ cache: "no-store" },
			),
		);
		if (
			connection.id !== initial.connectionId ||
			connection.status !== "released" ||
			typeof connection.releasedAt !== "string" ||
			!Number.isFinite(Date.parse(connection.releasedAt))
		)
			return unconfirmed("release_unconfirmed");
		const allocationId = connection.allocationId;
		if (
			typeof allocationId !== "string" ||
			!/^[A-Za-z0-9_-]{1,160}$/.test(allocationId) ||
			(initial.allocationId && initial.allocationId !== allocationId)
		)
			return unconfirmed("runtime_unknown");
		result = { ...result, allocationId, releasedAt: connection.releasedAt };
		const allocation = await json(
			await control(
				`/v1/allocations/${encodeURIComponent(allocationId)}`,
				signal,
				{ cache: "no-store" },
			),
		);
		const bindings = list(allocation.bindings).filter(
			(b) => b.capability === "vision.perception",
		);
		if (
			allocation.id !== allocationId ||
			bindings.length !== 1 ||
			typeof bindings[0]!.runtime !== "string" ||
			!/^[A-Za-z0-9_.-]{1,160}$/.test(bindings[0]!.runtime)
		)
			return unconfirmed("runtime_unknown");
		result.runtimeId = bindings[0]!.runtime;
		for (;;) {
			const state = await json(
				await control("/state", signal, { cache: "no-store" }),
			);
			const runtime = list(state.runtimes).find(
				(r) => r.id === result.runtimeId,
			);
			const observedAt =
				typeof runtime?.observedAt === "string"
					? Date.parse(runtime.observedAt)
					: NaN;
			const now = Date.now();
			// 10 seconds is the maximum snapshot age; future observations are not evidence.
			if (
				state.online === true &&
				runtime?.status === "COLD" &&
				observedAt >= Date.parse(result.releasedAt!) &&
				observedAt <= now &&
				now - observedAt <= 10000
			)
				return {
					...result,
					status: "cold",
					observedAt: runtime.observedAt as string,
					checkedAt: now,
				};
			await pause(options.pollMs ?? 1000, signal);
		}
	} catch {
		return unconfirmed(
			signal.aborted ? "observation_timeout" : "observation_failed",
		);
	}
}
