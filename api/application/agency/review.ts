import { defaultLimits, type Opportunity } from "eumenes-agency";
import type { Conv } from "./host-types";

/** The existing review timer also admits native recalls, independently of the speech planner. */
export function createReview(input: {
	enabled(): boolean;
	convs: ReadonlyMap<string, Conv>;
	now(): number;
	setTimer(fn: () => void, ms: number): unknown;
	run(c: Conv, trigger: Opportunity["trigger"]): Promise<unknown>;
}) {
	function arm(c: Conv) {
		if (!input.enabled() || c.reviewTimer !== undefined) return;
		c.reviewTimer = input.setTimer(() => {
			delete c.reviewTimer;
			if (!input.enabled() || input.convs.get(c.id) !== c) return;
			const snap = c.runtime.snapshot();
			const pending = snap.observations.some(
				(o) =>
					o.seq > snap.cursor &&
					(o.kind === "action.observed" || o.kind === "delivery.observed"),
			);
			if (
				c.background ||
				(pending &&
					input.now() <
						(snap.state.lastOutboundAt ?? input.now()) +
							defaultLimits.outboundIntervalMs)
			)
				return arm(c);
			void input
				.run(c, pending ? "result_received" : "review_due")
				.finally(() => arm(c));
		}, 60_000);
	}
	return arm;
}
