import type { ArtifactRuntime } from "@eumenes/artifact-ui";
import type { Resource, Snapshot } from "@eumenes/artifact-ui/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import { timerReceiptSchema } from "../../../../api/domains/timers/contracts";
import { queryRoots } from "../../queryKeys";
import type {
	AdapterHostContext,
	AdapterState,
	WebArtifactAdapter,
} from "../toolchain-artifacts/registry";
import { bindServerClock } from "./clock";
import { useClockWorkspace, withClockControls } from "./clock-runtime";
import { useDeadline } from "./deadline";
import { setupResource, timerResource, type TimerView } from "./timer-resource";

export const TIMER_ADAPTER_REF = "adapter:timers@1";
const SETUP_QUERY = "query:timers.setup@1";
const CURRENT_QUERY = "query:timers.current@1";

const domainMessages: Record<string, string> = {
	timer_not_resumable: "このタイマーは再開できません。",
	timer_not_found: "タイマーが見つかりません。画面を更新してください。",
	operation_expired: "このタイマーの表示期限が過ぎました。",
};
const fieldMessages: Record<string, string> = {
	hours: "時間・分・秒は0以上の整数で入力してください",
	minutes: "時間・分・秒は0以上の整数で入力してください",
	seconds: "時間・分・秒は0以上の整数で入力してください",
	durationSeconds: "時間は1秒〜24時間で入力してください",
};

/**
 * The timer's side of the common artifact host: the clock sources (server time, deadline
 * wake-ups, the local stopwatch), how a settled receipt changes the screen, and the saved-timer
 * selection. Everything persistent still happens in the timers domain behind the action host.
 */
function useTimerArtifact({
	client,
	artifact,
	targetRef,
	setTargetRef,
	visible,
}: AdapterHostContext): AdapterState {
	const cache = useQueryClient();
	const query = useQuery({
		queryKey: [queryRoots.timers, client.identity, "item", targetRef],
		enabled: !!targetRef,
		queryFn: async ({ signal }) => {
			const sent = performance.now();
			const sentAt = Date.now();
			const result = await client.timer(targetRef!, signal);
			return {
				...result,
				sentAt,
				clock: bindServerClock(result.serverNow, sent, performance.now()),
			} satisfies TimerView;
		},
		refetchOnWindowFocus: "always",
		refetchOnReconnect: "always",
	});
	const data = targetRef ? query.data : undefined;
	// SSE reports changes; the expiry itself is the only event the server cannot push.
	useDeadline(
		data?.timer.state === "active" ? [data.timer.dueAt] : [],
		data?.serverNow,
		data?.sentAt ?? 0,
		() =>
			void cache.invalidateQueries({
				queryKey: [queryRoots.timers, client.identity, "item", targetRef],
			}),
	);
	const [monoNow, refreshClock] = useState(() => performance.now());
	useEffect(() => {
		if (data?.timer.state !== "active" || data.timer.bodyExpired) return;
		const id = window.setInterval(() => refreshClock(performance.now()), 250);
		return () => window.clearInterval(id);
	}, [data]);
	const clock = useClockWorkspace({
		source: targetRef ? `timer-${targetRef}` : "timer-setup",
		visible,
	});

	const sources = new Map(artifact.sourceBindings.map((s) => [s.source, s]));
	const current: Resource =
		data && !data.timer.bodyExpired
			? timerResource(data, monoNow, true)
			: setupResource;
	const base: Record<string, Resource> = {};
	for (const binding of artifact.sourceBindings) {
		if (binding.query === SETUP_QUERY) base[binding.source] = setupResource;
		else if (binding.query === CURRENT_QUERY) base[binding.source] = current;
	}
	const rejectLocal: ArtifactRuntime = {
		snapshot: base as Snapshot,
		dispatch: async () => ({
			status: "rejected",
			message: "この操作は利用できません",
		}),
	};
	const clocked = withClockControls(rejectLocal, clock);

	const refresh = useCallback(
		() => void cache.invalidateQueries({ queryKey: [queryRoots.timers] }),
		[cache],
	);
	const phase: AdapterState["phase"] =
		targetRef && query.isPending
			? { kind: "loading" }
			: targetRef && (query.isError || !data)
				? {
						kind: "error",
						message: "タイマーを取得できません。接続を確認してください。",
					}
				: data?.timer.bodyExpired
					? {
							kind: "blocked",
							message: "このタイマーの表示期限が過ぎました",
						}
					: { kind: "ready" };
	return {
		phase,
		snapshot: clocked.snapshot,
		targetOf: (source) =>
			sources.get(source)?.query === CURRENT_QUERY ? targetRef : undefined,
		async local(binding, event) {
			if (binding.eventAction === "timer-new") {
				setTargetRef(undefined);
				return { status: "accepted", message: "" };
			}
			return clocked.dispatch(event);
		},
		settled(_binding, result, timing) {
			const receipt = timerReceiptSchema.safeParse(result.receipt);
			if (!receipt.success || receipt.data.action === "listed") {
				refresh();
				return;
			}
			const { timer, serverNow } = receipt.data;
			// The confirmed receipt keeps the clock visible during the first GET.
			const previous = cache.getQueryData<TimerView>([
				queryRoots.timers,
				client.identity,
				"item",
				timer.id,
			]);
			cache.setQueryData<TimerView>(
				[queryRoots.timers, client.identity, "item", timer.id],
				{
					serverNow,
					timer,
					notification: previous?.notification ?? null,
					sentAt: timing.sentAt,
					clock: bindServerClock(serverNow, timing.sent, performance.now()),
				},
			);
			if (receipt.data.action === "started") setTargetRef(timer.id);
			refresh();
		},
		refresh,
		describeRejection(code, fieldErrors) {
			const field = fieldErrors.find((e) => fieldMessages[e.field]);
			if (field) return fieldMessages[field.field];
			return code ? domainMessages[code] : undefined;
		},
		answerInput(question, text) {
			if (question.inputSchemaRef === "builtin:timerTargetAnswer") {
				const choice = question.choices?.find((c) => c.label === text);
				return choice
					? { ok: true, value: { timerId: choice.ref } }
					: { ok: false, message: "候補から選んでください。" };
			}
			if (question.inputSchemaRef === "builtin:answerText" && text)
				return { ok: true, value: { text } };
			return { ok: false, message: "この質問への回答を確認してください。" };
		},
	};
}

export const timerWebAdapter: WebArtifactAdapter = {
	adapterRef: TIMER_ADAPTER_REF,
	useArtifact: useTimerArtifact,
};
