import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArtifactRenderer, type ArtifactRuntime } from "@eumenes/artifact-ui";
import "@eumenes/artifact-ui/styles";
import { timerDefinition } from "../../../domains/timers/artifact-definition";
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
import {
	withClockControls,
	type ClockControls,
} from "../../../domains/timers/clock-runtime";

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
	onNewTimer,
	definition: storedDefinition,
	clock,
}: {
	client: EumenesClient;
	timerId: string;
	onNewTimer?: () => void;
	definition?: string;
	clock?: ClockControls;
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
	const control = useMutation({
		mutationFn: (operation: "pause" | "resume" | "cancel") => {
			const timer = query.data?.timer;
			if (!timer) throw new Error("timer_not_found");
			return client[
				operation === "pause"
					? "pauseTimer"
					: operation === "resume"
						? "resumeTimer"
						: "cancelTimer"
			](timer.id, {
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
			pausedAt: timer.pausedAt,
			remainingSeconds: timer.remainingSeconds,
		},
		estimatedServerNow(
			query.data.clock,
			Math.max(monoNow, query.data.clock.baseMono),
		),
	);
	const confirming = timer.state === "active" && seconds === 0;
	const duration = durationLabel(timer.durationSeconds);
	const definition = storedDefinition ?? timerDefinition(timerId);
	const source = `timer-${timerId}`;
	const runtime: ArtifactRuntime = {
		snapshot: {
			[source]: {
				kind: "timer-workspace",
				revision: timer.revision,
				state: confirming ? "confirming" : timer.state,
				title:
					timer.label === "タイマー" ? `${duration}のタイマー` : timer.label,
				durationSeconds: timer.durationSeconds,
				remainingSeconds: seconds,
				durationLabel: duration,
				dueAt:
					timer.state === "cancelled" || timer.state === "paused"
						? undefined
						: timer.dueAt,
				finishLabel: finishLabel(timer.dueAt, query.data.serverNow),
				canCreate: !!onNewTimer,
			},
		},
		dispatch: async (event) => {
			if (event.source !== source || event.revision !== timer.revision)
				return {
					status: "conflict",
					message: "タイマーの状態が変わりました。もう一度お試しください。",
				};
			if (event.action === "timer-new" && onNewTimer) {
				onNewTimer();
				return { status: "accepted", message: "" };
			}
			const operation =
				event.action === "timer-pause"
					? "pause"
					: event.action === "timer-resume"
						? "resume"
						: event.action === "timer-cancel"
							? "cancel"
							: null;
			if (!operation)
				return { status: "rejected", message: "この操作は利用できません" };
			await control.mutateAsync(operation);
			return { status: "accepted", message: "" };
		},
	};
	return (
		<ArtifactRenderer
			definition={definition}
			runtime={withClockControls(runtime, clock)}
		/>
	);
}
