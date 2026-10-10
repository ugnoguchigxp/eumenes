import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, DigitalClock } from "../../../design-system";
import { useEffect, useState } from "react";
import type { EumenesClient } from "../../../../../client";
import { queryRoots } from "../../../queryKeys";
import {
	bindServerClock,
	displayRemainingSeconds,
	estimatedServerNow,
} from "../../../domains/timers/clock";
import { useDeadline } from "../../../domains/timers/deadline";
import "./TimerArtifact.css";

function durationLabel(seconds: number) {
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	const remainder = seconds % 60;
	return `${hours ? `${hours}時間` : ""}${minutes ? `${minutes}分` : ""}${remainder ? `${remainder}秒` : ""}`;
}

function finishLabel(dueAt: string, serverNow: string) {
	const due = new Date(dueAt);
	const today = due.toDateString() === new Date(serverNow).toDateString();
	return new Intl.DateTimeFormat("ja-JP", {
		...(today ? {} : { month: "short", day: "numeric" }),
		hour: "numeric",
		minute: "2-digit",
	}).format(due);
}

function TimerMessage({ children }: { children: string }) {
	return <output className="timer-artifact-message">{children}</output>;
}

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
		queryFn: async ({ signal }) => {
			const sent = performance.now();
			const sentAt = Date.now();
			const result = await client.timer(timerId, signal);
			return {
				...result,
				sentAt,
				clock: bindServerClock(result.serverNow, sent, performance.now()),
			};
		},
		refetchOnWindowFocus: "always",
		refetchOnReconnect: "always",
	});
	// SSE reports changes; the expiry itself is the only event the server cannot push.
	useDeadline(
		query.data?.timer.state === "active" ? [query.data.timer.dueAt] : [],
		query.data?.serverNow,
		query.data?.sentAt ?? 0,
		() =>
			void cache.invalidateQueries({
				queryKey: [queryRoots.timers, "item", timerId],
			}),
	);
	const [monoNow, refreshClock] = useState(() => performance.now());
	useEffect(() => {
		if (query.data?.timer.state !== "active" || query.data.timer.bodyExpired)
			return;
		const id = window.setInterval(() => refreshClock(performance.now()), 250);
		return () => window.clearInterval(id);
	}, [query.data]);
	const cancel = useMutation({
		mutationFn: () => {
			const timer = query.data?.timer;
			if (!timer) throw new Error("timer_not_found");
			return client.cancelTimer(timer.id, {
				requestId: crypto.randomUUID(),
				issuedAt: new Date(
					estimatedServerNow(query.data!.clock, performance.now()),
				).toISOString(),
				expectedRevision: timer.revision,
			});
		},
		onSuccess: () =>
			cache.invalidateQueries({
				queryKey: [queryRoots.timers],
			}),
		onError: () =>
			cache.invalidateQueries({
				queryKey: [queryRoots.timers, "item", timerId],
			}),
	});
	if (query.isPending)
		return <TimerMessage>タイマーを読み込んでいます</TimerMessage>;
	if (query.isError || !query.data)
		return (
			<TimerMessage>
				タイマーを取得できません。接続を確認してください。
			</TimerMessage>
		);
	const { timer } = query.data;
	if (timer.bodyExpired)
		return <TimerMessage>このタイマーの表示期限が過ぎました</TimerMessage>;
	const seconds = displayRemainingSeconds(
		{
			dueAt: timer.dueAt,
			serverNow: query.data.serverNow,
			state: timer.state,
			cancelledAt: timer.cancelledAt,
		},
		estimatedServerNow(
			query.data.clock,
			Math.max(monoNow, query.data.clock.baseMono),
		),
	);
	const confirming = timer.state === "active" && seconds === 0;
	const duration = durationLabel(timer.durationSeconds);
	const remaining = Math.min(
		100,
		Math.max(0, (seconds / timer.durationSeconds) * 100),
	);
	const status =
		timer.state === "cancelled"
			? "取消済み"
			: timer.state === "elapsed"
				? "時間になりました"
				: confirming
					? "終了を確認中"
					: "計測中";
	return (
		<section
			className="timer-artifact"
			aria-label={timer.label}
			data-state={timer.state}
		>
			<div className="timer-artifact-content">
				<header className="timer-artifact-heading">
					<span className="timer-artifact-icon" aria-hidden="true">
						<svg
							width="24"
							height="24"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="1.5"
							strokeLinecap="round"
							strokeLinejoin="round"
						>
							<path d="M9 2h6M12 2v3m6 1 1.5-1.5" />
							<circle cx="12" cy="14" r="8" />
							<path d="M12 10v4l2.5 1.5" />
						</svg>
					</span>
					<h2>
						{timer.label === "タイマー" ? `${duration}のタイマー` : timer.label}
					</h2>
					{timer.label !== "タイマー" && (
						<p className="timer-artifact-duration">{duration}</p>
					)}
				</header>
				<output className="timer-artifact-status">
					<span className="timer-artifact-status-dot" aria-hidden="true" />
					{status}
				</output>
				<DigitalClock
					seconds={seconds}
					format={timer.durationSeconds >= 3600 ? "hh:mm:ss" : "mm:ss"}
					className={
						timer.durationSeconds >= 3600
							? "timer-artifact-clock timer-artifact-clock-long"
							: "timer-artifact-clock"
					}
					size="hero"
					tone={
						timer.state === "cancelled"
							? "muted"
							: timer.state === "elapsed"
								? "finished"
								: "default"
					}
				/>
				<div className="timer-artifact-progress" aria-hidden="true">
					<div style={{ width: `${remaining}%` }} />
				</div>
				<p className="timer-artifact-finish">
					{timer.state === "cancelled" ? (
						"タイマーを取り消しました"
					) : (
						<>
							<span>{timer.state === "elapsed" ? "終了時刻" : "終了予定"}</span>
							<time dateTime={timer.dueAt}>
								{finishLabel(timer.dueAt, query.data.serverNow)}
							</time>
						</>
					)}
				</p>
				<div className="timer-artifact-actions">
					{timer.state === "active" && (
						<Button
							type="button"
							variant="outline"
							className="timer-artifact-cancel"
							loading={cancel.isPending}
							onClick={() => cancel.mutate()}
						>
							取り消す
						</Button>
					)}
					{cancel.isError && (
						<p className="timer-artifact-error" role="alert">
							取消に失敗しました。もう一度試してください。
						</p>
					)}
				</div>
			</div>
		</section>
	);
}
