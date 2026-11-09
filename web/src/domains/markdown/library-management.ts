import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { EumenesClient } from "../../../../client";
import type {
	LibraryFeatures,
	LibraryPage,
} from "../../../../api/domains/markdown/contracts";
import { ApiError } from "../../../../client/transport";
import type { ArtifactEvent } from "@eumenes/artifact-ui/contracts";
const errors: Record<string, string> = {
	overlapping_selection: "親フォルダーと配下を重ねずに選択してください。",
	etag_mismatch:
		"文書やフォルダーが更新されました。一覧を更新して再確認してください。",
	markdown_unsaved_changes:
		"対象に未保存の変更があります。編集を開き、保存するか変更を破棄してください。",
	markdown_management_pending:
		"結果不明の操作があります。先に結果を確認してください。",
	markdown_save_in_progress:
		"保存中または保存結果が不明です。保存状態を確認してください。",
	work_busy: "共同編集中の文書です。共同編集を終了してから操作してください。",
	path_exists: "同じ保存場所が使われています。",
	unsupported_items: "Markdown以外を含むフォルダーは操作できません。",
	invalid_destination: "その移動先・コピー先は使えません。",
	folder_not_empty:
		"フォルダーに項目があります。配下を含める場合は確認してください。",
	forbidden: "この操作の権限がありません。",
	payload_too_large: "容量または対象件数の上限を超えています。",
	revision_conflict: "一覧または編集が更新されました。再確認してください。",
};
export function managementMessage(e: unknown): string {
	if (e instanceof ApiError)
		return (
			errors[e.message.replace(/^markdown_/, "")] ??
			errors[e.message] ??
			(e.status === 412
				? errors.etag_mismatch!
				: e.status === 413
					? errors.payload_too_large!
					: e.status === 403
						? errors.forbidden!
						: "操作を完了できませんでした。入力は保持しています。")
		);
	return "操作の結果を確認できません。状態を更新して確認してください。";
}
export function useLibraryManagement(input: {
	client: EumenesClient;
	features?: LibraryFeatures;
	namespaces: string[];
	visible: boolean;
	selected?: string;
	refresh(): void;
	setTargetRef(id: string | undefined): void;
}) {
	const { client, features } = input;
	const [files, setFiles] = useState<LibraryPage | undefined>(),
		[knownFolders, setKnownFolders] = useState<
			Extract<LibraryPage["entries"][number], { kind: "folder" }>[]
		>([]),
		[loading, setLoading] = useState(false),
		[error, setError] = useState<string>();
	const sequence = useRef(0),
		controller = useRef<AbortController | null>(null),
		latest = useRef(files);
	useEffect(() => {
		latest.current = files;
	}, [files]);
	const operations = useQuery({
		queryKey: ["markdown-management", client.identity],
		enabled: input.visible && !!features?.library,
		queryFn: ({ signal }) => client.markdownOperations(signal),
		refetchInterval: input.visible && features?.library ? 1500 : false,
		retry: false,
	});
	const load = useCallback(
		async (namespace: string, path: string, cursor?: string) => {
			if (!features?.library) return;
			const n = ++sequence.current;
			controller.current?.abort();
			const c = new AbortController();
			controller.current = c;
			setLoading(true);
			setError(undefined);
			try {
				const page = await client.markdownFiles(
					{ namespace, path, ...(cursor ? { cursor } : {}) },
					c.signal,
				);
				if (n !== sequence.current || c.signal.aborted) return;
				const prior = latest.current;
				if (
					cursor &&
					(!prior ||
						prior.etag !== page.etag ||
						prior.namespace !== namespace ||
						prior.path !== path)
				) {
					setError(
						"取得中に一覧が更新されました。一覧を更新してから操作してください。",
					);
					setFiles(undefined);
					return;
				}
				const merged = {
					...page,
					entries: cursor
						? [
								...new Map(
									[...prior!.entries, ...page.entries].map((e) => [e.id, e]),
								).values(),
							]
						: page.entries,
				};
				latest.current = merged;
				setFiles(merged);
				setKnownFolders((prev) => [
					...new Map(
						[...prev, ...page.entries.filter((e) => e.kind === "folder")].map(
							(e) => [e.id, e],
						),
					).values(),
				]);
			} catch (e) {
				if (n === sequence.current && !c.signal.aborted)
					setError(managementMessage(e));
			} finally {
				if (n === sequence.current) {
					controller.current = null;
					setLoading(false);
				}
			}
		},
		[client, features?.library],
	);
	const firstNamespace = input.namespaces[0];
	useEffect(() => {
		if (
			features?.library &&
			firstNamespace &&
			!latest.current &&
			(!controller.current || controller.current.signal.aborted)
		)
			void load(firstNamespace, "");
	}, [features?.library, firstNamespace, load]);
	useEffect(() => () => controller.current?.abort(), [load]);
	async function adopt(
		result: Awaited<ReturnType<EumenesClient["markdownManage"]>>,
	) {
		if (result.state === "applied" || result.state === "confirmed") {
			for (const id of result.removedWorkspaceIds) {
				localStorage.removeItem(`eumenes:markdown:draft:${id}`);
				if (input.selected === id) input.setTargetRef(undefined);
			}
			setKnownFolders([]);
			input.refresh();
			if (latest.current)
				await load(latest.current.namespace, latest.current.path);
		}
		await operations.refetch();
		return {
			status:
				result.state === "applied" || result.state === "confirmed"
					? ("accepted" as const)
					: ("rejected" as const),
			message:
				result.state === "confirmed"
					? "現在の状態が要求と一致することを確認しました。"
					: result.state === "applied"
						? ""
						: result.state === "unknown"
							? "結果不明です。変更を再送せず「結果を確認」を使ってください。"
							: result.state === "conflict"
								? errors.etag_mismatch!
								: (errors[result.code ?? ""] ??
									errors[result.code?.replace(/^markdown_/, "") ?? ""] ??
									"操作できませんでした。入力は保持しています。"),
		};
	}
	async function local(event: ArtifactEvent) {
		try {
			if (event.action === "markdown-files") {
				await load(
					String(event.values.namespace),
					String(event.values.path),
					event.values.cursor ? String(event.values.cursor) : undefined,
				);
				return { status: "accepted" as const, message: "" };
			}
			if (event.action === "markdown-check")
				return adopt(await client.markdownCheck(String(event.values.id)));
			const result = await client.markdownManage({
				stageId: String(event.values.stageId),
			});
			return adopt(result);
		} catch (e) {
			await operations.refetch();
			return { status: "rejected" as const, message: managementMessage(e) };
		}
	}
	return {
		files,
		knownFolders,
		filesLoading: loading,
		filesError: error,
		operations: operations.data ?? [],
		local,
		reload: () =>
			latest.current
				? load(latest.current.namespace, latest.current.path)
				: Promise.resolve(),
	};
}
