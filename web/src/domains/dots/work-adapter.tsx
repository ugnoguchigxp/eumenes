import {
	useInfiniteQuery,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useEffect } from "react";
import type { Resource, Snapshot } from "@eumenes/artifact-ui/contracts";
import type { WorkDetailView } from "../../../../api/domains/dots/contracts";
import type {
	AdapterHostContext,
	AdapterState,
	WebArtifactAdapter,
} from "../toolchain-artifacts/registry";
import { useDotsWorkSettings } from "./work-settings-adapter";

const labels: Record<string, string> = {
	registered: "登録のみ",
	queued: "依頼済み・開始未確認",
	active: "作業中",
	waiting_user: "回答待ち",
	paused: "一時停止",
	reconciling: "結果未確認",
	stopping: "停止を確認中",
	completed: "完了・受取済み",
	failed: "失敗",
	cancelled: "取消済み",
};
type Page = {
	items: Array<{ ref: string; title: string; state: string; revision: number }>;
	nextOffset: number | null;
};
type Detail = WorkDetailView;
type Activity = {
	commands: Array<{
		id: string;
		kind: string;
		state: string;
		createdAt: number;
	}>;
};
type Connection = {
	connection: {
		title: string;
		enabled: boolean;
		oauthConfigured: boolean;
	} | null;
	project: { title: string; environment: string; enabled: boolean } | null;
	enabled: boolean;
};
export function useDotsWork(context: AdapterHostContext): AdapterState {
	const { client, artifactRevisionId, targetRef, setTargetRef, visible } =
			context,
		cache = useQueryClient();
	const prefix = ["dots-work", client.identity, artifactRevisionId];
	const jobs = useInfiniteQuery({
		queryKey: [...prefix, "jobs"],
		initialPageParam: 0,
		retry: false,
		queryFn: async ({ pageParam, signal }) =>
			(
				await client.toolchainArtifactSource(
					artifactRevisionId,
					"dots-jobs",
					undefined,
					signal,
					{ offset: pageParam },
				)
			).data as Page,
		getNextPageParam: (p) => p.nextOffset ?? undefined,
	});
	const detail = useQuery({
		queryKey: [...prefix, "detail", targetRef],
		enabled: !!targetRef,
		retry: false,
		queryFn: async ({ signal }) =>
			(
				await client.toolchainArtifactSource(
					artifactRevisionId,
					"dots-work",
					targetRef,
					signal,
				)
			).data as Detail,
	});
	const activity = useQuery({
		queryKey: [...prefix, "activity", targetRef],
		enabled: !!targetRef,
		retry: false,
		queryFn: async ({ signal }) =>
			(
				await client.toolchainArtifactSource(
					artifactRevisionId,
					"dots-activity",
					targetRef,
					signal,
				)
			).data as Activity,
	});
	const connection = useQuery({
		queryKey: [...prefix, "connection"],
		retry: false,
		queryFn: async ({ signal }) =>
			(
				await client.toolchainArtifactSource(
					artifactRevisionId,
					"dots-connection",
					undefined,
					signal,
				)
			).data as Connection,
	});
	const refresh = useCallback(() => {
		void cache.invalidateQueries({ queryKey: ["dots-work", client.identity] });
	}, [cache, client.identity]);
	useEffect(
		() => (visible ? client.subscribeChanges(refresh) : undefined),
		[client, visible, refresh],
	);
	const items = jobs.data?.pages.flatMap((p) => p.items) ?? [];
	const firstRef = items[0]?.ref;
	useEffect(() => {
		if (!targetRef && firstRef) setTargetRef(firstRef);
	}, [targetRef, firstRef, setTargetRef]);
	const current = targetRef ? detail.data : undefined,
		task = current?.task,
		c = connection.data;
	const connectionMessage = !c?.connection
		? "接続先は未設定です。設定で登録済みの接続先と作業先を選んでください。"
		: !c.enabled
			? `${c.connection.title}：仕事の受付は無効です。保存済みの履歴を表示します。`
			: `${c.connection.title}：${c.project?.title ?? "登録済みの作業先"}へ依頼します。PC停止中の結果はChatGPTで確認してください。`;
	const snapshot: Record<string, Resource> = {
		"dots-jobs": {
			kind: "work-menu",
			revision: 0,
			items: items.map((i) => ({
				id: i.ref,
				label: i.title,
				status: labels[i.state] ?? i.state,
			})),
			selectedId: targetRef,
			selectedTitle: task?.title,
			hasMore: jobs.hasNextPage,
			loading: jobs.isFetching,
			message: connectionMessage,
		},
		"dots-work": {
			kind: "work-result",
			revision: task?.revision ?? 0,
			targetRef,
			...(task
				? {
						work: {
							title: task.title,
							status: labels[task.state] ?? task.state,
							summary: task.result?.summary ?? current?.report?.summary,
							request: task.request ?? undefined,
							conditions: task.completionConditions,
							sessions: current!.sessions.map((s) => s.threadId),
							sections: [
								...(current?.report?.facts.length
									? [{ title: "報告された内容", items: current.report.facts }]
									: []),
								...(current?.report?.limitations.length
									? [
											{
												title: "未解決事項・制約",
												items: current.report.limitations,
											},
										]
									: []),
								...(task.result
									? [{ title: "根拠の参照", items: task.result.evidenceRefs }]
									: []),
							],
							question: current?.question
								? {
										id: current.question.id,
										prompt: current.question.prompt,
										choices: current.question.choices,
									}
								: undefined,
							canPause: ![
								"completed",
								"failed",
								"cancelled",
								"stopping",
								"paused",
							].includes(task.state),
							canCancel:
								!["completed", "failed", "cancelled"].includes(task.state) &&
								task.stopIntent !== "cancel",
							message: current!.sessions.length
								? undefined
								: "依頼の保存と実作業の開始は別です。",
						},
					}
				: {}),
		},
		"dots-activity": {
			kind: "activity-timeline",
			revision: task?.revision ?? 0,
			connected: !activity.isError,
			entries: (activity.data?.commands ?? []).map((cmd) => ({
				id: cmd.id,
				at: new Date(cmd.createdAt).toISOString(),
				title:
					(
						{
							start: "依頼を保存",
							answer: "回答を保存",
							stop: "停止を依頼",
							reconcile: "状態を照合",
							reminder: "通知を登録",
						} as Record<string, string>
					)[cmd.kind] ?? cmd.kind,
				detail:
					(
						{
							pending: "外部の取得待ち",
							claimed: "外部が取得",
							reported: "外部から報告あり",
							superseded: "以前の操作",
						} as Record<string, string>
					)[cmd.state] ?? cmd.state,
			})),
		},
	};
	return {
		phase: jobs.isError
			? { kind: "error", message: "仕事一覧を取得できません。" }
			: jobs.isPending
				? { kind: "loading" }
				: detail.isError && targetRef
					? {
							kind: "blocked",
							message: "この仕事は取得できません。一覧から選び直してください。",
						}
					: { kind: "ready" },
		snapshot: snapshot as Snapshot,
		targetOf: (source) =>
			["dots-work", "dots-activity"].includes(source) ? targetRef : undefined,
		async local(binding, event) {
			if (binding.eventAction === "work-select") {
				const id = event.values.taskRef;
				if (typeof id !== "string" || !items.some((i) => i.ref === id))
					return {
						status: "rejected",
						message: "一覧から仕事を選んでください。",
					};
				setTargetRef(id);
				return { status: "accepted", message: "" };
			}
			if (binding.eventAction === "work-more") {
				await jobs.fetchNextPage();
				return { status: "accepted", message: "" };
			}
			if (binding.eventAction === "work-refresh") {
				refresh();
				return {
					status: "accepted",
					message: "保存済みの状態を更新しています。",
				};
			}
			return { status: "rejected", message: "この操作は利用できません。" };
		},
		settled: refresh,
		refresh,
		describeRejection: (code) =>
			({
				dots_stale: "仕事または設定が更新されました。内容を確認してください。",
				dots_permission_denied: "この仕事への操作は許可されていません。",
			})[code ?? ""],
	};
}
export const dotsWorkWebAdapter: WebArtifactAdapter = {
	adapterRef: "adapter:dots-delegation@1",
	useArtifact: (context) =>
		context.artifact.id === "settings.dots"
			? useDotsWorkSettings(context)
			: useDotsWork(context),
};
