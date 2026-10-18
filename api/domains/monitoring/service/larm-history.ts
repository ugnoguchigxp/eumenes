import type { MonitoringEvent } from "../../larm/contracts";
import type { CollectedLarm, LarmView } from "../contracts/larm";

export function rememberGap(
	state: CollectedLarm,
	reason: CollectedLarm["gaps"][number]["reason"],
	at: number,
	detail?: string,
) {
	if (
		state.gaps.at(-1)?.reason === reason &&
		state.gaps.at(-1)?.bootEpoch === state.bootEpoch &&
		state.gaps.at(-1)?.detail === detail
	)
		return;
	state.gaps.push({
		at,
		reason,
		...(state.bootEpoch ? { bootEpoch: state.bootEpoch } : {}),
		...(detail ? { detail } : {}),
	});
	state.gapCount = String(BigInt(state.gapCount) + 1n);
	state.gaps = state.gaps.slice(-64);
}

/** Only request terminals count, once per opaque work ID in the current stream. */
export function larmView(
	state: CollectedLarm,
	events: readonly MonitoringEvent[],
): LarmView {
	const { cursor: _cursor, page, ...visible } = state;
	const results = {
		succeeded: "0",
		failed: "0",
		timed_out: "0",
		cancelled: "0",
		rejected: "0",
	};
	const works = new Set<string>();
	const eventStream =
		page && page.bootEpoch === state.bootEpoch
			? page.eventStream
			: state.snapshot?.bootEpoch === state.bootEpoch
				? state.snapshot?.eventStream
				: undefined;
	const current = events
		.filter((e) => e.streamId === eventStream?.streamId)
		.sort((a, b) =>
			BigInt(a.sequence) < BigInt(b.sequence)
				? -1
				: BigInt(a.sequence) > BigInt(b.sequence)
					? 1
					: 0,
		);
	for (const e of current) {
		if (e.kind !== "request.terminal" && e.kind !== "request.rejected")
			continue;
		if (!e.outcome || !(e.outcome in results)) continue;
		const work = e.workId ?? e.id;
		if (works.has(work)) continue;
		works.add(work);
		const outcome = e.outcome as keyof typeof results;
		results[outcome] = String(BigInt(results[outcome]) + 1n);
	}
	const sources = [
		"larm_gateway",
		"music_jobs",
		"image_jobs",
		"control_operations",
		"kernel_events",
	];
	const coverageComplete =
		!!page &&
		!page.hasMore &&
		page.eventStream.continuity !== "gap" &&
		sources.every((id) => {
			const c = page.coverage.find((c) => c.id === id);
			return (
				c?.status === "available" &&
				c.since !== null &&
				c.through !== null &&
				c.since <= page.window.from &&
				c.through >= page.window.through
			);
		});
	const faultKinds = new Set([
		"host.oom_kill_observed",
		"gpu.reset_observed",
		"gpu.ring_timeout_observed",
		"gpu.page_fault_observed",
		"gpu.execution_fault_observed",
	]);
	const faults = new Map<string, MonitoringEvent>();
	for (const e of current)
		if (faultKinds.has(e.kind)) {
			const key = JSON.stringify([e.kind, e.target]);
			const previous = faults.get(key);
			if (
				!previous ||
				Date.parse(previous.occurredAt) < Date.parse(e.occurredAt)
			)
				faults.set(key, e);
		}
	return {
		...visible,
		history: {
			...(eventStream ? { eventStream } : {}),
			...(page
				? {
						coverage: page.coverage,
						window: page.window,
					}
				: {}),
			hasMore: page?.hasMore ?? false,
			coverageComplete,
			events: events.slice(-200),
			faults: [...faults.values()],
			results,
		},
	};
}
