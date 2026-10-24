import type { Receipt, TerminalsResource } from "@eumenes/artifact-ui";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useRef } from "react";
import { terminalSessionsViewSchema } from "../../../../api/domains/terminals/contracts";
import { ApiError } from "../../../../client";
import { queryRoots } from "../../queryKeys";
import type { WebArtifactAdapter } from "../toolchain-artifacts/registry";
import { createTerminalConnection } from "../toolchain-artifacts/terminal-connection";

const TERMINALS_ADAPTER_REF = "adapter:terminals@1";
/** Size of a new session until its pane measures itself. */
const INITIAL_SIZE = { cols: 120, rows: 32 };

const MESSAGES: Record<string, string> = {
	terminal_unavailable: "Claude Code が見つかりません。",
	terminal_limit_reached: "同時に開ける Claude Code の上限に達しました。",
	terminal_running: "この Claude Code はまだ実行中です。",
	terminal_not_found: "このセッションは既に終了しています。",
};
const rejected = (error: unknown): Receipt => ({
	status: "rejected",
	message:
		(error instanceof ApiError && MESSAGES[error.message]) ||
		"Claude Code を操作できませんでした。接続を確認してください。",
});
const accepted: Receipt = { status: "accepted", message: "" };

/**
 * The registered session list is read through the artifact source; PTY start, input, output and
 * close use the authenticated terminal API, so they never pass through the action ledger.
 */
export const terminalsWebAdapter: WebArtifactAdapter = {
	adapterRef: TERMINALS_ADAPTER_REF,
	useArtifact({ client, artifact, artifactRevisionId }) {
		const source = artifact.sourceBindings[0]?.source ?? "terminals";
		const sizes = useRef(new Map<string, { cols: number; rows: number }>());
		const list = useQuery({
			// Refreshed on backend change events, so sessions the conversation starts appear here.
			queryKey: [queryRoots.terminals, client.identity, artifactRevisionId],
			queryFn: async ({ signal }) => {
				const read = await client.toolchainArtifactSource(
					artifactRevisionId,
					source,
					undefined,
					signal,
				);
				return terminalSessionsViewSchema.parse(read.data);
			},
			retry: false,
		});
		const { refetch } = list;
		const reload = useCallback(() => {
			void refetch();
		}, [refetch]);
		const openTerminal = useCallback(
			(_source: string, sessionId: string) =>
				createTerminalConnection(client, sessionId, {
					onEnded: reload,
					onResized: (size) => sizes.current.set(sessionId, size),
				}),
			[client, reload],
		);
		const data = list.data;
		const resource: TerminalsResource | undefined = data && {
			kind: "terminal-workspace",
			revision: data.revision,
			available: data.available,
			sessions: data.sessions.map((s) => ({
				id: s.id,
				title: s.title,
				...(s.owner.startsWith("kanban:") ? { heading: s.title } : {}),
				status: s.status,
				run: s.run,
				...(s.status === "exited"
					? {
							statusMessage:
								s.exitCode === null || s.exitCode === undefined
									? "停止しました"
									: `終了コード ${s.exitCode}`,
						}
					: {}),
			})),
		};
		return {
			// A failed re-read keeps the screens that are already running.
			phase: data
				? { kind: "ready" }
				: list.isError
					? {
							kind: "error",
							message:
								"Claude Code の状態を取得できません。接続を確認してください。",
						}
					: { kind: "loading" },
			snapshot: resource ? { [source]: resource } : {},
			openTerminal,
			targetOf: () => undefined,
			async local(_binding, event) {
				const id = typeof event.values.id === "string" ? event.values.id : "";
				try {
					if (event.action === "terminal-start")
						await client.startTerminal(INITIAL_SIZE);
					else if (event.action === "terminal-restart")
						await client.restartTerminal(
							id,
							sizes.current.get(id) ?? INITIAL_SIZE,
						);
					else return { status: "rejected", message: "この操作はできません。" };
					return accepted;
				} catch (error) {
					return rejected(error);
				} finally {
					await refetch();
				}
			},
			settled: () => {},
			refresh: reload,
		};
	},
};
