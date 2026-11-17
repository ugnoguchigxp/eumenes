import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { EumenesClient } from "../../../client";
import type { ContextCaptureSummary } from "../../../api/domains/dialogue/contracts";
import { Button } from "../design-system";
import { queryRoots } from "../queryKeys";
import {
	ContextInputDetail,
	ContextInputDiff,
	inputBoundary,
	inputTime,
} from "./ContextInputDetail";
import "./ConversationContextPanel.css";

export type ContextSelection =
	{ mode: "latest" } | { mode: "fixed"; runId: string; captureId?: string };

const inputStatus: Record<string, string> = {
	queued: "待機中",
	running: "応答中",
	completed: "完了",
	succeeded: "応答あり",
	failed: "失敗",
	cancelled: "中止",
	interrupted: "中断",
};

function useContextList(
	client: EumenesClient,
	runId: string | undefined,
	connectionRevision: number,
) {
	return useQuery({
		queryKey: [
			queryRoots.dialogue,
			client.identity,
			"context-inputs",
			runId,
			connectionRevision,
		],
		queryFn: ({ signal }) => client.runContext(runId!, signal),
		enabled: runId !== undefined,
		retry: false,
		gcTime: 0,
	});
}

function useContextCapture(
	client: EumenesClient,
	selected?: ContextCaptureSummary,
) {
	const [expired, setExpired] = useState<string>();
	const entry =
		selected?.available && selected.id !== expired ? selected : undefined;
	useEffect(() => {
		if (!entry) return;
		const stop = setTimeout(
			() => setExpired(entry.id),
			Math.max(0, entry.expiresAt - Date.now()),
		);
		return () => clearTimeout(stop);
	}, [entry]);
	const result = useQuery({
		queryKey: [
			queryRoots.dialogue,
			client.identity,
			"context-input",
			entry?.runId,
			entry?.id,
		],
		queryFn: ({ signal }) =>
			client.contextCapture(entry!.runId, entry!.id, signal),
		enabled: entry !== undefined,
		staleTime: "static",
		gcTime: 0,
		retry: false,
	});
	return {
		data: result.isError ? undefined : result.data,
		pending: entry !== undefined && result.isPending,
	};
}

export function ConversationContextPanel({
	client,
	selection,
	latestRunId,
	answer,
	disconnected,
	onSelect,
	onClose,
}: {
	client: EumenesClient;
	selection: ContextSelection;
	latestRunId?: string;
	answer?: string;
	disconnected: boolean;
	onSelect(selection: ContextSelection): void;
	onClose(): void;
}) {
	const panel = useRef<HTMLElement>(null);
	const close = useRef<HTMLButtonElement>(null);
	const [showDiff, setShowDiff] = useState(false);
	const [connection, setConnection] = useState({ disconnected, revision: 0 });
	if (connection.disconnected !== disconnected)
		setConnection({ disconnected, revision: connection.revision + 1 });
	const live = selection.mode === "latest";
	const runId = selection.mode === "fixed" ? selection.runId : latestRunId;
	const list = useContextList(
		client,
		disconnected ? undefined : runId,
		connection.revision,
	);
	const view = list.isError ? undefined : list.data;
	const selectedId =
		selection.mode === "fixed" && selection.captureId
			? selection.captureId
			: live
				? view?.captures.at(-1)?.id
				: view?.preferredId;
	const selected = view?.captures.find((entry) => entry.id === selectedId);
	const detail = useContextCapture(client, selected);
	const snapshot = detail.data;
	const previous = showDiff ? snapshot?.previous : null;
	const other = useContextList(
		client,
		previous && previous.runId !== runId ? previous.runId : undefined,
		connection.revision,
	);
	const previousEntries =
		previous?.runId === runId
			? view?.captures
			: other.isError
				? undefined
				: other.data?.captures;
	const previousEntry = previousEntries?.find(
		(entry) => entry.id === previous?.id,
	);
	const prior = useContextCapture(client, previousEntry);
	const comparing =
		previous &&
		((previous.runId !== runId && other.isPending) || prior.pending);
	useEffect(() => {
		close.current?.focus();
	}, []);
	useEffect(() => {
		const listener = (event: KeyboardEvent) => {
			if (
				event.key !== "Escape" ||
				!panel.current?.contains(document.activeElement)
			)
				return;
			event.preventDefault();
			onClose();
		};
		window.addEventListener("keydown", listener);
		return () => window.removeEventListener("keydown", listener);
	}, [onClose]);
	return (
		<aside
			ref={panel}
			id="conversation-context"
			className="conversation-context"
			aria-labelledby="conversation-context-title"
		>
			<header>
				<h2 id="conversation-context-title">コンテキスト</h2>
				<Button
					type="button"
					ref={close}
					variant="ghost"
					size="sm"
					onClick={onClose}
				>
					閉じる
				</Button>
			</header>
			<div className="conversation-context-body">
				<Button
					type="button"
					variant="outline"
					size="sm"
					aria-pressed={live}
					onClick={() => onSelect({ mode: "latest" })}
				>
					最新を追う
				</Button>
				{!live && <small> この返答に固定中</small>}
				{answer && (
					<details>
						<summary>対応する返答</summary>
						<pre>{answer}</pre>
					</details>
				)}
				{disconnected && (
					<output>更新が止まっています。再接続を待っています。</output>
				)}
				{view?.captures.length ? (
					<label className="context-input-select">
						送信した入力
						<select
							value={selected?.id ?? ""}
							onChange={(event) =>
								runId &&
								onSelect({
									mode: "fixed",
									runId,
									captureId: event.target.value,
								})
							}
						>
							{!selected && <option value="">取得できる入力を選択</option>}
							{view.captures.map((entry) => (
								<option key={entry.id} value={entry.id}>
									送信 {entry.number} · {inputTime(entry.at)} ·{" "}
									{inputBoundary[entry.boundary]}
									{entry.accepted
										? " · 採用"
										: ` · ${inputStatus[entry.status] ?? entry.status}`}
								</option>
							))}
						</select>
					</label>
				) : null}
				{!disconnected && !runId && <output>会話の入力を待っています。</output>}
				{!disconnected && runId && list.isPending && (
					<output>入力の一覧を取得中</output>
				)}
				{(list.isError || (view && view.captures.length === 0)) && (
					<output>
						{view?.empty === "preparing"
							? "入力を準備中"
							: view?.empty === "no_send"
								? "送信前に終了しました。"
								: "取得できる記録がありません。"}
					</output>
				)}
				{view?.captures.length && selectedId && !selected ? (
					<output>選んだ入力の記録がありません。</output>
				) : null}
				{selected && !selected.available && (
					<output>容量上限で本文を取得できません。</output>
				)}
				{selected?.available && !snapshot && (
					<output>
						{detail.pending ? "入力を取得中" : "取得できる記録がありません。"}
					</output>
				)}
				{snapshot && (
					<>
						{snapshot.previous && (
							<Button
								type="button"
								variant="outline"
								size="sm"
								aria-pressed={showDiff}
								onClick={() => setShowDiff(!showDiff)}
							>
								前の入力との差分
							</Button>
						)}
						{previous &&
							(prior.data ? (
								<ContextInputDiff previous={prior.data} current={snapshot} />
							) : (
								<output>
									{comparing
										? "比較元の入力を確認中"
										: "比較元の記録がありません。"}
								</output>
							))}
						<ContextInputDetail capture={snapshot} />
					</>
				)}
			</div>
		</aside>
	);
}
