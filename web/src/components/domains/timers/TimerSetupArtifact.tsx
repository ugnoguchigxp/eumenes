import { ArtifactRenderer, type ArtifactRuntime } from "@eumenes/artifact-ui";
import "@eumenes/artifact-ui/styles";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import type { ArtifactEvent, Receipt } from "@eumenes/artifact-ui/contracts";
import type { EumenesClient } from "../../../../../client";
import { startTimerSchema } from "../../../../../api/domains/timers/contracts";
import { timerSetupSource } from "../../../domains/timers/artifact-definition";
import { queryRoots } from "../../../queryKeys";
import { bindServerClock } from "../../../domains/timers/clock";
import {
	withClockControls,
	type ClockControls,
} from "../../../domains/timers/clock-runtime";

/** The OpenUI clock sends a typed operation to the existing timer API. */
export function TimerSetupArtifact({
	client,
	definition,
	onStarted,
	clock,
}: {
	client: EumenesClient;
	definition: string;
	onStarted: (ref: { timerId: string }, title: string) => void;
	clock?: ClockControls;
}) {
	const cache = useQueryClient();
	const dispatch = useCallback(
		async (event: ArtifactEvent): Promise<Receipt> => {
			if (
				event.source !== timerSetupSource ||
				event.action !== "timer-start" ||
				event.revision !== 0
			)
				return { status: "rejected", message: "この操作は利用できません" };
			const parts = [
				event.values.hours,
				event.values.minutes,
				event.values.seconds,
			];
			if (
				parts.some(
					(value) =>
						typeof value !== "string" ||
						!Number.isInteger(Number(value)) ||
						Number(value) < 0,
				)
			)
				return {
					status: "rejected",
					message: "時間・分・秒は0以上の整数で入力してください",
				};
			const input = startTimerSchema.safeParse({
				requestId: event.id,
				issuedAt: new Date().toISOString(),
				durationSeconds:
					Number(parts[0]) * 3600 + Number(parts[1]) * 60 + Number(parts[2]),
			});
			if (!input.success)
				return {
					status: "rejected",
					message: "時間は1秒〜24時間で入力してください",
				};
			const sent = performance.now();
			const sentAt = Date.now();
			const receipt = await client.startTimer(input.data);
			if (receipt.action !== "started")
				return {
					status: "rejected",
					message: "タイマーの開始を確認できませんでした",
				};
			// The confirmed start snapshot keeps the clock visible during its first GET.
			cache.setQueryData([queryRoots.timers, "item", receipt.timer.id], {
				serverNow: receipt.serverNow,
				timer: receipt.timer,
				notification: null,
				sentAt,
				clock: bindServerClock(receipt.serverNow, sent, performance.now()),
			});
			onStarted(receipt.artifact, receipt.timer.label);
			void cache.invalidateQueries({ queryKey: [queryRoots.timers] });
			return { status: "accepted", message: "タイマーを開始しました" };
		},
		[client, cache, onStarted],
	);
	const runtime: ArtifactRuntime = {
		snapshot: {
			[timerSetupSource]: {
				kind: "timer-workspace",
				revision: 0,
				state: "setup",
			},
		},
		dispatch,
	};
	return (
		<ArtifactRenderer
			definition={definition}
			runtime={withClockControls(runtime, clock)}
		/>
	);
}
