import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DigitalClock } from "@eumenes/design-system";
import { useEffect, useState } from "react";
import type { EumenesClient } from "../../../../client";
import { queryRoots } from "../../queryKeys";
import {
	bindServerClock,
	displayRemainingSeconds,
	estimatedServerNow,
} from "./clock";

export function TimerArtifact({
	client,
	timerId,
}: {
	client: EumenesClient;
	timerId: string;
}) {
	const cache = useQueryClient();
	const query = useQuery({
		queryKey: [queryRoots.timers, "item", timerId],
		queryFn: () => client.timer(timerId),
	});
	const [tick, setTick] = useState(0);
	useEffect(() => {
		const id = window.setInterval(() => setTick((value) => value + 1), 250);
		return () => window.clearInterval(id);
	}, []);
	const cancel = useMutation({
		mutationFn: () => {
			const timer = query.data?.timer;
			if (!timer) throw new Error("timer_not_found");
			return client.cancelTimer(timer.id, {
				requestId: crypto.randomUUID(),
				issuedAt: new Date().toISOString(),
				expectedRevision: timer.revision,
			});
		},
		onSuccess: () =>
			cache.invalidateQueries({ queryKey: [queryRoots.timers, "item", timerId] }),
	});
	if (query.isPending) return <p>タイマーを読み込んでいます</p>;
	if (query.isError || !query.data)
		return <p>タイマーが見つかりません</p>;
	const { timer, serverNow } = query.data;
	if (timer.bodyExpired) return <p>このタイマーの表示期限が過ぎました</p>;
	const sent = performance.now();
	const clock = bindServerClock(serverNow, sent, sent);
	void tick;
	const seconds = displayRemainingSeconds(
		timer,
		estimatedServerNow(clock, performance.now()),
	);
	const confirming = timer.state === "active" && seconds === 0;
	const dueLabel = new Date(timer.dueAt).toLocaleString();
	return (
		<section className="timer-artifact" aria-label={timer.label}>
			<p>{timer.label}</p>
			<DigitalClock
				seconds={seconds}
				size="hero"
				tone={
					timer.state === "cancelled"
						? "muted"
						: timer.state === "elapsed"
							? "finished"
							: "default"
				}
			/>
			<p>
				{timer.state === "cancelled"
					? "取消済み"
					: timer.state === "elapsed"
						? "時間になりました"
						: confirming
							? "終了を確認中"
							: "計測中"}
			</p>
			<p>終了予定 {dueLabel}</p>
			{timer.state === "active" && (
				<button
					type="button"
					disabled={cancel.isPending}
					onClick={() => cancel.mutate()}
				>
					取り消す
				</button>
			)}
			{cancel.isError && <p>取消に失敗しました。もう一度試してください。</p>}
		</section>
	);
}
