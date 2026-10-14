import type { Receipt, TerminalsResource } from "@eumenes/artifact-ui";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useRef } from "react";
import { terminalSessionsViewSchema } from "../../../../api/domains/terminals/contracts";
import { ApiError } from "../../../../client";
import { queryRoots } from "../../queryKeys";
import type { WebArtifactAdapter } from "../toolchain-artifacts/registry";
import { createTerminalConnection } from "./connection";

export const TERMINALS_ADAPTER_REF = "adapter:terminals@1";
/** Size of a new session until its pane measures itself. */
const INITIAL_SIZE = { cols: 120, rows: 32 };

const MESSAGES: Record<string, string> = {
	terminal_unavailable: "Claude Code が見つかりません。",
	terminal_limit_reached: "同時に開けるターミナルの上限に達しました。",
	terminal_running: "このターミナルはまだ実行中です。",
	terminal_not_found: "このターミナルは既に閉じられています。",
};
const rejected = (error: unknown): Receipt => ({
	status: "rejected",
	message:
		(error instanceof ApiError && MESSAGES[error.message]) ||
		"ターミナルを操作できませんでした。接続を確認してください。",
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
			queryKey: [
				queryRoots.toolchainArtifacts,
				client.identity,
				"terminals",
				artifactRevisionId,
			],
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
			canStart: data.available && data.sessions.length < data.limit,
			sessions: data.sessions.map((s) => ({
				id: s.id,
				title: s.title,
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
			phase: list.isPending
				? { kind: "loading" }
				: list.isError
					? {
							kind: "error",
							message:
								"ターミナルの一覧を取得できません。接続を確認してください。",
						}
					: { kind: "ready" },
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
					else if (event.action === "terminal-close") {
						await client.closeTerminal(id);
						sizes.current.delete(id);
					} else
						return { status: "rejected", message: "この操作はできません。" };
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
