import type { KanbanBoardSource, KanbanResource } from "@eumenes/artifact-ui";
import type { ActivityResource } from "@eumenes/artifact-ui/contracts";
import { useQuery } from "@tanstack/react-query";
import { useCallback } from "react";
import { queryRoots } from "../../queryKeys";
import type {
	AdapterHostContext,
	AdapterState,
	WebArtifactAdapter,
} from "../toolchain-artifacts/registry";

const KANBAN_ADAPTER_REF = "adapter:kanban@1";
const DEFAULT_SOURCE = "kanban";

const REJECTIONS: Record<string, string> = {
	kanban_state_invalid:
		"いまのタスクの状態ではこの操作はできません。最新の表示を確認してください。",
	kanban_prompt_too_long:
		"依頼内容が長すぎて送れません。依頼内容を短くしてから、もう一度お試しください。",
	revision_conflict:
		"他の操作でタスクの状態が変わりました。最新の表示を読み込みました。内容を確認して、もう一度お試しください。",
	kanban_card_not_found:
		"タスクが見つかりません。画面を更新して確認してください。",
	kanban_card_busy: "このタスクは実行中のため、この操作はできません。",
	kanban_column_invalid: "このタスクは、その列には移せません。",
	kanban_not_runnable: "この環境では作業の状態を追えないため実行できません。",
	terminal_tracking_unavailable:
		"この環境では作業の状態を追えないため実行できません。",
	kanban_queue_paused:
		"実行キューが停止中です。理由を確認して再開してから、もう一度お試しください。",
	commit_push_requires_board:
		"commit & push はボードのボタンからだけ依頼できます。",
	kanban_conversation_busy:
		"このタスクの会話は別の作業で使われています。終わってからお試しください。",
	terminal_limit_reached: "同時に開ける Claude Code の上限に達しました。",
};
const FIELDS: Record<string, string> = {
	title: "タイトルは1〜40字で入力してください。",
	prompt: "依頼内容は1〜7850字で入力してください。",
	note: "追加の依頼は1〜4000字で入力してください。",
};

function isBoard(data: unknown): data is KanbanBoardSource {
	if (typeof data !== "object" || data === null) return false;
	const board = data as Partial<KanbanBoardSource>;
	return (
		typeof board.revision === "number" &&
		typeof board.runnable === "boolean" &&
		typeof board.queue === "object" &&
		board.queue !== null &&
		Array.isArray(board.cards) &&
		Array.isArray(board.runs)
	);
}

/**
 * The task board's side of the common artifact host: the board source (cards, runs, queue) is
 * read under the `kanban` query root, which backend change events refresh; every write goes
 * through the host's outbox and a settled write reads the board again.
 */
function useKanbanArtifact({
	client,
	artifact,
	artifactRevisionId,
	targetRef,
	setTargetRef,
	visible,
}: AdapterHostContext): AdapterState {
	const source = artifact.sourceBindings[0]?.source ?? DEFAULT_SOURCE;
	const board = useQuery({
		queryKey: [queryRoots.kanban, client.identity, artifactRevisionId, source],
		queryFn: async ({ signal }) => {
			const read = await client.toolchainArtifactSource(
				artifactRevisionId,
				source,
				undefined,
				signal,
			);
			if (!isBoard(read.data)) throw new Error("kanban_board_invalid");
			return { revision: read.revision, board: read.data };
		},
		retry: false,
	});
	const activitySource = artifact.sourceBindings.find(
		(s) => s.query === "query:kanban.activity@1",
	)?.source;
	const activity = useQuery({
		queryKey: [
			queryRoots.kanban,
			client.identity,
			artifactRevisionId,
			activitySource,
			targetRef,
		],
		enabled: !!activitySource && !!targetRef,
		refetchInterval: visible ? 1500 : false,
		queryFn: async ({ signal }) => {
			const read = await client.toolchainArtifactSource(
				artifactRevisionId,
				activitySource!,
				targetRef,
				signal,
			);
			const data = read.data as Omit<ActivityResource, "kind" | "revision">;
			if (!Array.isArray(data.entries))
				throw new Error("kanban_activity_invalid");
			return {
				kind: "activity-timeline" as const,
				revision: read.revision,
				...data,
			};
		},
	});
	const { refetch } = board;
	const reload = useCallback(() => {
		void refetch();
	}, [refetch]);
	const data = board.data;
	const resource: KanbanResource | undefined = data && {
		kind: "kanban-board",
		revision: data.revision,
		board: data.board,
	};
	return {
		// A failed re-read keeps the board that is already shown.
		phase: data
			? { kind: "ready" }
			: board.isError
				? {
						kind: "error",
						message: "タスクボードを取得できません。接続を確認してください。",
					}
				: { kind: "loading" },
		snapshot: {
			...(resource ? { [source]: resource } : {}),
			...(activitySource
				? {
						[activitySource]: activity.data ?? {
							kind: "activity-timeline" as const,
							revision: 0,
							entries: [],
							connected: true,
							emptyText: "カードの活動を選んでください",
						},
					}
				: {}),
		},
		targetOf: () => undefined,
		local: async (_binding, event) => {
			if (event.action === "kanban-inspect" && event.values?.cardId) {
				setTargetRef(String(event.values.cardId));
				return { status: "accepted", message: "活動を表示しました" };
			}
			return { status: "rejected", message: "この操作はできません。" };
		},
		settled: async () => {
			await refetch();
		},
		refresh: reload,
		describeRejection(code, fieldErrors) {
			const field = fieldErrors.find((e) => FIELDS[e.field]);
			if (field) return FIELDS[field.field];
			return code ? REJECTIONS[code] : undefined;
		},
	};
}

export const kanbanWebAdapter: WebArtifactAdapter = {
	adapterRef: KANBAN_ADAPTER_REF,
	useArtifact: useKanbanArtifact,
};

export const sharedKanbanWebAdapter: WebArtifactAdapter = {
	adapterRef: "adapter:kanban@2",
	useArtifact: useKanbanArtifact,
};
