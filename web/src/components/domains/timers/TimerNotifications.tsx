import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { EumenesClient } from "../../../../../client";
import { queryRoots } from "../../../queryKeys";
import type { TimerNotificationDto } from "../../../../../api/domains/timers/contracts";
import { TimerNotificationCenter } from "./TimerNotificationCenter";

type Attempt = {
	id: string;
	revision: number;
	controller: AbortController;
	deferred?: boolean;
	delivered?: boolean;
};

/** Scope-wide notices survive panel changes and normal polling during a claim. */
export function TimerNotifications({
	client,
	playTone,
	muted = false,
	busy = false,
	inputBusy,
	audioReady = true,
	prepareAudio,
	repeatTone,
}: {
	client: EumenesClient;
	playTone: (
		signal: AbortSignal,
		message?: string,
		onToneDelivered?: () => void,
	) => Promise<void>;
	muted?: boolean;
	busy?: boolean;
	inputBusy?: () => boolean;
	audioReady?: boolean;
	prepareAudio?: () => Promise<void>;
	repeatTone?: (signal: AbortSignal) => Promise<void>;
}) {
	const cache = useQueryClient();
	const clientId = useRef(crypto.randomUUID());
	const active = useRef<{ attempt: Attempt | null }>({ attempt: null });
	const lifecycle = useRef({ epoch: 0 });
	const latest = useRef({ playTone, muted, busy, inputBusy });
	useEffect(() => {
		latest.current = { playTone, muted, busy, inputBusy };
	}, [playTone, muted, busy, inputBusy]);
	const [error, setError] = useState<string | null>(null);
	const [stoppingIds, setStoppingIds] = useState<string[]>([]);
	const [ringingId, setRingingId] = useState<string | null>(null);
	const alarm = useRef<AbortController | null>(null);
	const query = useQuery({
		queryKey: [queryRoots.timers, "notifications"],
		queryFn: async ({ signal }) => {
			let page = await client.timerNotifications({ limit: 100 }, signal);
			const items = [...page.items];
			while (page.nextCursor) {
				page = await client.timerNotifications(
					{ limit: 100, cursor: page.nextCursor },
					signal,
				);
				items.push(...page.items);
			}
			return {
				serverNow: page.serverNow,
				activeTimers: page.activeTimers,
				items,
			};
		},
		refetchInterval: (query) =>
			(query.state.data?.activeTimers ?? 0) > 0 ||
			query.state.data?.items.some(
				(item) => item.status === "pending" || item.status === "claimed",
			)
				? 1000
				: false,
	});
	const refresh = () =>
		cache.invalidateQueries({ queryKey: [queryRoots.timers] });
	useEffect(() => {
		const cycle = lifecycle.current;
		const state = active.current;
		const token = ++cycle.epoch;
		// StrictMode immediately re-runs setup; only a real unmount stops playback.
		return () =>
			queueMicrotask(() => {
				if (cycle.epoch === token) state.attempt?.controller.abort();
			});
	}, [client]);
	useEffect(() => {
		const attempt = active.current.attempt;
		if (!attempt) return;
		const note = query.data?.items.find((item) => item.id === attempt.id);
		if (busy || latest.current.inputBusy?.()) attempt.deferred = true;
		if (
			busy ||
			latest.current.inputBusy?.() ||
			muted ||
			(note &&
				note.revision >= attempt.revision &&
				["dismissed", "silent", "played"].includes(note.status))
		)
			attempt.controller.abort();
	}, [query.data, query.dataUpdatedAt, busy, muted]);
	useEffect(() => {
		if (
			active.current.attempt ||
			(!audioReady && !muted) ||
			((busy || latest.current.inputBusy?.()) && !muted) ||
			!query.data
		)
			return;
		const note = query.data.items.find(
			(item) =>
				item.status === "pending" &&
				Date.parse(query.data!.serverNow) - Date.parse(item.dueAt) <= 300_000,
		);
		if (!note) return;
		const attempt: Attempt = {
			id: note.id,
			revision: note.revision,
			controller: new AbortController(),
		};
		active.current.attempt = attempt;
		void (async () => {
			let claimId: string | undefined;
			let timeout: ReturnType<typeof setTimeout> | undefined;
			try {
				if (latest.current.muted) {
					await client.silenceTimerNotification(note.id, {
						expectedRevision: note.revision,
						reason: "muted",
					});
					return;
				}
				const claimed = await client.claimTimerNotification(note.id, {
					clientId: clientId.current,
					claimRequestId: crypto.randomUUID(),
					expectedRevision: note.revision,
				});
				claimId = claimed.claimId;
				attempt.revision = claimed.notification.revision;
				if (!claimId) return;
				const available =
					Date.parse(claimed.leaseUntil ?? "") -
					Date.parse(claimed.serverNow) -
					1000;
				if (
					available <= 0 ||
					Date.parse(claimed.serverNow) -
						Date.parse(claimed.notification.dueAt) >
						300_000
				)
					throw new Error("claim_expired");
				timeout = setTimeout(
					() => attempt.controller.abort(),
					Math.min(available, 10_000),
				);
				attempt.controller.signal.throwIfAborted();
				if (latest.current.busy || latest.current.inputBusy?.()) {
					attempt.deferred = true;
					return;
				}
				if (latest.current.muted) throw new Error("audio_unavailable");
				await latest.current.playTone(
					attempt.controller.signal,
					note.message,
					() => {
						attempt.delivered = true;
					},
				);
				attempt.controller.signal.throwIfAborted();
				await client.ackTimerNotification(note.id, {
					clientId: clientId.current,
					claimId,
					outcome: "played",
				});
				if (repeatTone) setRingingId(note.id);
			} catch {
				if (
					claimId &&
					(attempt.delivered || !attempt.deferred || latest.current.muted)
				) {
					try {
						await client.ackTimerNotification(note.id, {
							clientId: clientId.current,
							claimId,
							outcome: attempt.delivered
								? "played"
								: latest.current.muted
									? "muted"
									: "blocked",
						});
						if (attempt.delivered && repeatTone) setRingingId(note.id);
					} catch {
						/* A cancelled or expired claim must not be adopted. */
					}
				}
			} finally {
				if (timeout) clearTimeout(timeout);
				if (active.current.attempt === attempt) active.current.attempt = null;
				void cache.invalidateQueries({
					queryKey: [queryRoots.timers, "notifications"],
				});
			}
		})();
	}, [
		cache,
		client,
		query.data,
		query.dataUpdatedAt,
		busy,
		muted,
		audioReady,
		repeatTone,
	]);
	const canRing =
		!busy &&
		!muted &&
		audioReady &&
		query.data?.items.some(
			(item) => item.id === ringingId && item.status === "played",
		);
	useEffect(() => {
		if (!canRing || !repeatTone) return;
		const controller = new AbortController();
		alarm.current = controller;
		void repeatTone(controller.signal).catch(() => {});
		return () => {
			controller.abort();
			if (alarm.current === controller) alarm.current = null;
		};
	}, [canRing, ringingId, repeatTone]);
	const notices = (query.data?.items ?? []).filter(
		(item) => item.status !== "dismissed",
	);
	const needsAudio =
		!audioReady &&
		!muted &&
		prepareAudio &&
		((query.data?.activeTimers ?? 0) > 0 ||
			notices.some((item) => item.status === "pending"));
	const stop = (item: TimerNotificationDto) => {
		if (stoppingIds.includes(item.id)) return;
		setStoppingIds((ids) => [...ids, item.id]);
		if (ringingId === item.id) {
			alarm.current?.abort();
			setRingingId(null);
		}
		if (active.current.attempt?.id === item.id)
			active.current.attempt.controller.abort();
		void (async () => {
			try {
				const current = await client.timer(item.timerId);
				await client.cancelTimer(item.timerId, {
					requestId: crypto.randomUUID(),
					issuedAt: current.serverNow,
					expectedRevision: current.timer.revision,
				});
				setError(null);
			} catch {
				setError("通知を停止できませんでした。もう一度試してください。");
			} finally {
				await refresh();
				setStoppingIds((ids) => ids.filter((id) => id !== item.id));
			}
		})();
	};
	return (
		<TimerNotificationCenter
			notices={notices}
			ringingId={canRing ? ringingId : null}
			stoppingIds={stoppingIds}
			onStop={stop}
			onPrepareAudio={
				needsAudio
					? () => {
							void prepareAudio!().catch(() =>
								setError(
									"音声を開始できませんでした。もう一度お試しください。",
								),
							);
						}
					: undefined
			}
			error={
				error ??
				(query.isError
					? "通知を取得できませんでした。画面を再読み込みしてください。"
					: null)
			}
		/>
	);
}
