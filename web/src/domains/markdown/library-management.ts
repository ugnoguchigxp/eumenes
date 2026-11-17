import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { EumenesClient } from "../../../../client";
import type {
	LibraryFeatures,
	LibraryFilesQuery,
	LibraryPage,
} from "../../../../api/domains/markdown/contracts";
import { ApiError } from "../../../../client/transport";
import type { ArtifactEvent } from "@eumenes/artifact-ui/contracts";
type LoadedPage = LibraryPage & Pick<LibraryFilesQuery, "sort">;

function invalidCursor(error: unknown) {
	return (
		error instanceof ApiError &&
		error.status === 400 &&
		["markdown_invalid_cursor", "markdown_invalid_pagination"].includes(
			error.message,
		)
	);
}

const errors: Record<string, string> = {
	overlapping_selection: "親フォルダーと配下を重ねずに選択してください。",
	etag_mismatch:
		"文書やフォルダーが更新されました。一覧を更新して再確認してください。",
	markdown_unsaved_changes:
		"対象に未保存の変更があります。編集を開き、保存するか変更を破棄してください。",
	markdown_management_pending:
		"結果不明の操作があります。先に結果を確認してください。",
	markdown_library_unsupported: "保存先がこの操作に対応していません。",
	markdown_not_found:
		"対象または操作の入力が見つかりません。一覧を更新して再確認してください。",
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
	request_conflict: "操作の入力が一致しません。対象を選び直してください。",
};
const unknownResult = "操作の結果は未確認です。";
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
	const sort = features?.updatedDesc ? "updated-desc" : undefined;
	const [files, setFiles] = useState<LoadedPage>(),
		[knownFolders, setKnownFolders] = useState<
			Extract<LibraryPage["entries"][number], { kind: "folder" }>[]
		>([]),
		[loading, setLoading] = useState(false),
		[error, setError] = useState<string>();
	const sequence = useRef(0),
		controller = useRef<AbortController | null>(null),
		latest = useRef<LoadedPage | undefined>(undefined);
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
			const readPage = (cursor?: string) =>
				client.markdownFiles({ namespace, path, sort, cursor }, c.signal);
			try {
				const previous = latest.current;
				let prior =
					cursor &&
					previous?.namespace === namespace &&
					previous.path === path &&
					previous.sort === sort &&
					previous.nextCursor === cursor
						? previous
						: undefined;
				let page =
					cursor && !prior
						? undefined
						: await readPage(cursor).catch((error: unknown) => {
								if (sort && cursor && invalidCursor(error)) return undefined;
								throw error;
							});
				if (n !== sequence.current || c.signal.aborted) return;
				if (!page || (prior && prior.etag !== page.etag)) {
					latest.current = undefined;
					setFiles(undefined);
					if (!sort) {
						setError(
							"取得中に一覧が更新されました。一覧を更新してから操作してください。",
						);
						return;
					}
					prior = undefined;
					page = await readPage();
					if (n !== sequence.current || c.signal.aborted) return;
				}
				const merged: LoadedPage = {
					...page,
					...(sort ? { sort } : {}),
					entries: prior
						? [
								...new Map(
									[...prior.entries, ...page.entries].map((e) => [e.id, e]),
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
		[client, features?.library, sort],
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
		if (result.state === "unknown")
			return { status: "indeterminate" as const, message: unknownResult };
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
			const result =
				event.action === "markdown-check"
					? await client.markdownCheck(String(event.values.id))
					: await client.markdownManage({
							stageId: String(event.values.stageId),
						});
			return await adopt(result);
		} catch (e) {
			await operations.refetch();
			if (event.action === "markdown-check")
				return {
					status: "indeterminate" as const,
					message:
						e instanceof ApiError && e.status === 404
							? "操作記録が見つかりません。ファイル一覧を更新して現在の状態を確認してください。"
							: "現在の状態を確認できません。時間をおいて再確認してください。",
				};
			if (
				e instanceof ApiError &&
				e.status >= 400 &&
				e.status < 500 &&
				e.status !== 408
			)
				return { status: "rejected" as const, message: managementMessage(e) };
			return { status: "indeterminate" as const, message: unknownResult };
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
