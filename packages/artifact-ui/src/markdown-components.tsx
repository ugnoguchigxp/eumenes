import { useMemo, useState } from "react";
import { markdownCacheFile } from "./markdown-cache";
import {
	MarkdownWorkspace,
	type MarkdownCurrent,
	type MarkdownDraft,
	type MarkdownLibraryEntry,
	type MarkdownWorkspaceProps,
} from "@eumenes/design-system/markdown";
import { useArtifactRuntime } from "./runtime";
import { useAction, Feedback } from "./action";
import type { ArtifactRequest } from "./contracts";

export type MarkdownResource = {
	kind: "markdown-workspace";
	revision: number;
	current: MarkdownCurrent | null;
	documents: { id: string; title: string }[];
	library: MarkdownLibraryEntry[];
	libraryStatus?: "idle" | "loading" | "ready" | "error";
	libraryHasMore?: boolean;
	namespaces?: string[];
	capabilities?: MarkdownWorkspaceProps["capabilities"];
	files?: MarkdownWorkspaceProps["files"];
	knownFolders?: MarkdownWorkspaceProps["knownFolders"];
	filesLoading?: boolean;
	filesError?: string;
	operations?: MarkdownWorkspaceProps["operations"];
	archiveAvailable: boolean;
	archiveError?: string;
	cacheAvailable?: boolean;
	sessionState: "active" | "suspended" | null;
	busy: boolean;
};
function recover(key: string, id: string): MarkdownDraft | null {
	try {
		const raw = localStorage.getItem(key);
		if (!raw || new TextEncoder().encode(raw).length > 8 * 1024 * 1024 + 8192)
			return null;
		const value = JSON.parse(raw);
		if (
			value.documentId !== id ||
			!Number.isInteger(value.baseRevision) ||
			value.baseRevision < 1 ||
			typeof value.title !== "string" ||
			new TextEncoder().encode(value.title).length > 4096 ||
			value.document?.formatVersion !== 1 ||
			!Array.isArray(value.document.nodes) ||
			!value.document.nodes.length
		)
			return null;
		let count = 0;
		const valid = (n: unknown, depth: number): boolean => {
			if (
				!n ||
				typeof n !== "object" ||
				Array.isArray(n) ||
				++count > 5000 ||
				depth > 32
			)
				return false;
			const node = n as { text?: unknown; type?: unknown; children?: unknown };
			return (
				typeof node.text === "string" ||
				(typeof node.type === "string" &&
					Array.isArray(node.children) &&
					node.children.length > 0 &&
					node.children.every((c) => valid(c, depth + 1)))
			);
		};
		if (
			!value.document.nodes.every((n: unknown) => valid(n, 0)) ||
			!(
				value.document.originalMarkdown === null ||
				typeof value.document.originalMarkdown === "string"
			)
		)
			return null;
		return value as MarkdownDraft;
	} catch {
		return null;
	}
}
export function MarkdownWorkspaceView({
	request,
}: {
	request: ArtifactRequest;
}) {
	const runtime = useArtifactRuntime();
	const action = useAction(request),
		r = action.resource?.kind === "markdown-workspace" ? action.resource : null;
	const [storageError, setStorageError] = useState(false);
	const currentId = r?.current?.id;
	const key = `eumenes:markdown:draft:${currentId ?? "none"}`;
	const recovery = useMemo(
		() => (currentId ? recover(key, currentId) : null),
		[key, currentId],
	);
	if (!r) return null;
	async function stage(document: unknown, markdown?: string) {
		const receipt = await runtime.uploadFile?.(
			action.source,
			new File(
				[
					JSON.stringify({
						document,
						...(markdown === undefined ? {} : { markdown }),
					}),
				],
				"document.json",
				{ type: "application/json" },
			),
		);
		return receipt?.status === "accepted" ? receipt.value : undefined;
	}
	const local = (name: "markdown-select" | "markdown-open", id: string) =>
		action.send(name, { id });
	return (
		<>
			<MarkdownWorkspace
				{...r}
				recovery={recovery}
				pending={action.pending}
				message={
					storageError
						? "ブラウザーに下書きを保管できません。画面を閉じる前にDoclingへの保存を確認するか、Markdownを書き出してください。"
						: action.message
				}
				onDraft={(draft) => {
					try {
						if (draft) localStorage.setItem(key, JSON.stringify(draft));
						else localStorage.removeItem(key);
						setStorageError(false);
					} catch {
						setStorageError(true);
					}
				}}
				onNew={async (title, document) => {
					const stageId = await stage(
						document,
						document.originalMarkdown ?? undefined,
					);
					return !!stageId && action.send("markdown-new", { title, stageId });
				}}
				onApply={async (draft) => {
					const stageId = await stage(draft.document);
					return (
						!!stageId &&
						action.send("markdown-apply", {
							documentId: draft.documentId,
							expectedRevision: String(draft.baseRevision),
							title: draft.title,
							stageId,
						})
					);
				}}
				onSave={async (documentId, revision, markdown) => {
					const stageId = await stage(r.current!.document, markdown);
					return (
						!!stageId &&
						action.send("markdown-archive", {
							documentId,
							expectedRevision: String(revision),
							stageId,
						})
					);
				}}
				onCache={async (draft, markdown, requestId) => {
					const file = markdownCacheFile(draft, markdown);
					const receipt = await runtime.uploadFile?.(action.source, file, {
						purpose: "markdown-cache",
						requestId,
					});
					return receipt?.status === "accepted";
				}}
				onFiles={(namespace, path, cursor) =>
					void action.send("markdown-files", {
						namespace,
						path,
						...(cursor ? { cursor } : {}),
					})
				}
				onManage={async (command, requestId) => {
					const receipt = await runtime.uploadFile?.(
						action.source,
						new File(
							[JSON.stringify({ command, requestId })],
							"operation.json",
							{ type: "application/json" },
						),
						{ purpose: "markdown-management" },
					);
					return (
						receipt?.status === "accepted" &&
						!!receipt.value &&
						action.send("markdown-manage", { stageId: receipt.value })
					);
				}}

				onCheck={(id) => void action.send("markdown-check", { id })}
				onSelect={(id) => local("markdown-select", id)}
				onOpen={(id) => local("markdown-open", id)}
				onReconcile={(id) => void action.send("markdown-reconcile", { id })}
				onLibrary={() => void action.send("markdown-library", {})}
				onMore={() => void action.send("markdown-more", {})}
				onResolve={(id, revision, etag) =>
					action.send("markdown-resolve", {
						id,
						revision: String(revision),
						etag,
					})
				}
				onReload={(id, revision) =>
					action.send("markdown-reload", { id, revision: String(revision) })
				}
				onReturn={() => void action.send("markdown-return", {})}
				onResume={() => void action.send("markdown-resume", {})}
			/>
			<Feedback message="" />
		</>
	);
}
