import { ArtifactRenderer, type ArtifactRuntime } from "@eumenes/artifact-ui";
import "@eumenes/artifact-ui/styles";
import { useQueryClient } from "@tanstack/react-query";
import type { EumenesClient } from "../../../../../client";
import { startTimerSchema } from "../../../../../api/domains/timers/contracts";
import { timerSetupSource } from "../../../domains/timers/artifact-definition";
import { queryRoots } from "../../../queryKeys";

/** The shared OpenUI form sends a typed operation to the existing timer API. */
export function TimerSetupArtifact({
	client,
	definition,
	onStarted,
}: {
	client: EumenesClient;
	definition: string;
	onStarted: (ref: { timerId: string }, title: string) => void;
}) {
	const cache = useQueryClient();
	const runtime: ArtifactRuntime = {
		snapshot: {
			[timerSetupSource]: {
				kind: "form",
				revision: 0,
				fields: [
					{ id: "minutes", label: "分", type: "number" },
					{ id: "seconds", label: "秒", type: "number" },
					{ id: "label", label: "名前（任意）", type: "text" },
				],
				defaults: { minutes: "3", seconds: "0", label: "" },
				submitLabel: "開始する",
			},
		},
		dispatch: async (event) => {
			if (
				event.source !== timerSetupSource ||
				event.action !== "submit" ||
				event.revision !== 0
			)
				return { status: "rejected", message: "この操作は利用できません" };
			const parts = [event.values.minutes, event.values.seconds];
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
					message: "分と秒は0以上の整数で入力してください",
				};
			const input = startTimerSchema.safeParse({
				requestId: event.id,
				issuedAt: new Date().toISOString(),
				durationSeconds: Number(parts[0]) * 60 + Number(parts[1]),
				...(event.values.label ? { label: event.values.label } : {}),
			});
			if (!input.success)
				return {
					status: "rejected",
					message: "時間は1秒〜24時間、名前は80文字以内で入力してください",
				};
			const receipt = await client.startTimer(input.data);
			if (receipt.action !== "started")
				return {
					status: "rejected",
					message: "タイマーの開始を確認できませんでした",
				};
			onStarted(receipt.artifact, receipt.timer.label);
			void cache.invalidateQueries({ queryKey: [queryRoots.timers] });
			return { status: "accepted", message: "タイマーを開始しました" };
		},
	};
	return <ArtifactRenderer definition={definition} runtime={runtime} />;
}
