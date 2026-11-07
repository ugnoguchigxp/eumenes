import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import type {
	MarkdownResource,
	Snapshot,
} from "@eumenes/artifact-ui/contracts";
import { markdownCurrentSchema } from "../../../../client/markdown";
import { formatResourceUri } from "../../../../api/domains/resources/contracts";
import {
	createLiveScreen,
	type WebArtifactAdapter,
} from "../toolchain-artifacts/registry";
import { markdownUploads } from "./uploads";
import { useSpecialistBridge } from "../toolchain-artifacts/specialist-bridge";

const sourceSchema = z.object({
	kind: z.literal("markdown-workspace"),
	revision: z.number(),
	current: markdownCurrentSchema.nullable(),
	documents: z.array(z.object({ id: z.string(), title: z.string() })),
	archiveAvailable: z.boolean(),
});
const live = createLiveScreen<{
	id: string | undefined;
	visible: boolean;
	artifactRevisionId: string;
	show(id: string): void;
}>();
export const markdownWebAdapter: WebArtifactAdapter = {
	adapterRef: "adapter:markdown@1",
	useArtifact({
		conversationId,
		client,
		artifactRevisionId,
		targetRef,
		setTargetRef,
		visible,
		notify,
	}) {
		const cache = useQueryClient(),
			bridge = useSpecialistBridge();
		const session =
			bridge?.session?.artifactRevisionId === artifactRevisionId
				? bridge.session
				: null;
		const [library, setLibrary] = useState<MarkdownResource["library"]>([]);
		const [libraryStatus, setLibraryStatus] =
			useState<MarkdownResource["libraryStatus"]>("idle");
		const [nextCursor, setNextCursor] = useState<string | null>(null);
		const [namespaces, setNamespaces] = useState<string[]>([]);
		const root = useMemo(
			() => ["markdown-workspace", client.identity, artifactRevisionId],
			[client.identity, artifactRevisionId],
		);
		const query = useQuery({
			queryKey: [...root, targetRef ?? null, session?.workRef ?? null],
			enabled: visible,
			queryFn: ({ signal }) =>
				client.toolchainArtifactSource(
					artifactRevisionId,
					"markdown-workspace",
					targetRef,
					signal,
					session ? { workRef: session.workRef } : {},
				),
			refetchInterval: visible ? 1500 : false,
		});
		const capabilities = useQuery({
			queryKey: [...root, "capabilities"],
			enabled: visible,
			queryFn: ({ signal }) => client.markdownCapabilities(signal),
			refetchInterval: visible ? 60000 : false,
		});
		const refresh = useCallback(() => {
			void cache.invalidateQueries({ queryKey: root });
		}, [cache, root]);
		useEffect(refresh, [refresh, session?.updatedAt, session?.revision]);
		const parsed = sourceSchema.safeParse(query.data?.data);
		const data = parsed.success ? parsed.data : null;
		const selected = data?.current?.id;
		const latest = useRef({
			id: selected,
			visible,
			artifactRevisionId,
			show: setTargetRef,
		});
		useEffect(() => {
			latest.current = {
				id: selected,
				visible,
				artifactRevisionId,
				show: setTargetRef,
			};
		}, [selected, visible, artifactRevisionId, setTargetRef]);
		useEffect(
			() => live.attach(latest.current),
			[selected, visible, artifactRevisionId, setTargetRef],
		);
		const snapshot: Snapshot = data
			? {
					"markdown-workspace": {
						...data,
						revision: query.data!.revision,
						library,
						libraryStatus,
						cacheAvailable: !!conversationId,
						namespaces,
						libraryHasMore: nextCursor !== null,
						capabilities: capabilities.data,
						archiveAvailable:
							data.archiveAvailable &&
							capabilities.isSuccess &&
							!capabilities.isError,
						archiveError: capabilities.isError
							? "Docling文書APIに接続できません。接続設定と権限を確認してください。"
							: undefined,
						sessionState:
							session?.state === "active" || session?.state === "suspended"
								? session.state
								: null,
						busy: !!session?.busy,
					} as MarkdownResource,
				}
			: {};
		async function select(id: string) {
			if (session?.state === "active" && bridge) {
				const result = await bridge.retarget(id, false);
				if (!result.ok)
					return { status: "rejected" as const, message: result.message };
			}
			setTargetRef(id);
			refresh();
			return { status: "accepted" as const, message: "" };
		}
		return {
			phase:
				query.isError || (query.data && !parsed.success)
					? { kind: "error", message: "文書を読み込めません。" }
					: data
						? { kind: "ready" }
						: { kind: "loading" },
			snapshot,
			targetOf: () => targetRef,
			uploadFile: markdownUploads(
				client,
				conversationId,
				capabilities.data?.maxRequestBytes,
			),
			async local(binding, event) {
				switch (binding.eventAction) {
					case "markdown-select":
						return select(String(event.values.id));
					case "markdown-reload":
					case "markdown-open": {
						try {
							const sourceId = String(event.values.id),
								remote = await client.markdownPreview(sourceId);
							let stageId: string | undefined;
							if (remote.document === null) {
								const { importMarkdown } =
									await import("@eumenes/design-system/markdown");
								stageId = (
									await client.markdownStage({
										document: importMarkdown(remote.markdown),
										markdown: remote.markdown,
									})
								).id;
							}
							const doc = await client.markdownOpen(sourceId, undefined, {
								stageId,
								expectedEtag: remote.entry.revision,
								...(binding.eventAction === "markdown-reload"
									? { replaceRevision: Number(event.values.revision) }
									: {}),
							});
							return select(doc.id);
						} catch {
							return {
								status: "rejected",
								message:
									"Doclingの文書を開けませんでした。作業中の変更がある場合は先に保存してください。",
							};
						}
					}
					case "markdown-resolve":
						try {
							await client.markdownResolve(
								String(event.values.id),
								Number(event.values.revision),
								String(event.values.etag),
							);
							refresh();
							return {
								status: "accepted",
								message:
									"手元の編集を残しました。内容を確認してDoclingに保存してください。",
							};
						} catch {
							return {
								status: "rejected",
								message:
									"文書の状態が変わりました。手元の編集を保持しています。保存状態を再確認してください。",
							};
						}
					case "markdown-reconcile":
						try {
							await client.markdownReconcile(String(event.values.id));
							refresh();
							return {
								status: "accepted",
								message: "保存状態を確認しました。",
							};
						} catch {
							return {
								status: "rejected",
								message:
									"保存状態を確認できませんでした。後でもう一度確認してください。",
							};
						}
					case "markdown-more":
					case "markdown-library":
						try {
							const more = binding.eventAction === "markdown-more";
							if (more && !nextCursor)
								return { status: "accepted", message: "" };
							setLibraryStatus("loading");
							const page = await client.markdownLibrary(
								undefined,
								more ? nextCursor! : undefined,
							);
							setLibrary((previous) => [
								...new Map(
									[...(more ? previous : []), ...page.items].map((d) => [
										d.sourceId,
										d,
									]),
								).values(),
							]);
							setNamespaces(page.namespaces);
							setNextCursor(page.nextCursor);
							setLibraryStatus("ready");
							return { status: "accepted", message: "" };
						} catch {
							setLibraryStatus("error");
							return {
								status: "rejected",
								message: "Doclingの一覧を取得できませんでした。",
							};
						}
					case "markdown-return":
					case "markdown-resume": {
						if (!bridge)
							return {
								status: "rejected",
								message: "共同編集の担当が見つかりません。",
							};
						const result = await bridge.command(
							binding.eventAction === "markdown-return" ? "return" : "resume",
						);
						refresh();
						return {
							status: result.ok ? "accepted" : "rejected",
							message: result.ok ? "" : result.message,
						};
					}
					case "markdown-stop": {
						if (bridge) await bridge.stopRun();
						return { status: "accepted", message: "停止を依頼しました。" };
					}
					case "markdown-refresh":
						refresh();
						return { status: "accepted", message: "" };
					default:
						return {
							status: "rejected",
							message: "この操作は利用できません。",
						};
				}
			},
			async settled(binding, result) {
				if (binding.eventAction === "markdown-new") {
					const id = result.resultRefs.find(
						(ref) => ref.owner === "markdown",
					)?.id;
					if (id) {
						const selected = await select(id);
						if (selected.status === "rejected") notify(selected.message);
					}
				}
				refresh();
			},
			refresh,
			describeRejection(code) {
				if (code === "markdown_document_too_large")
					return "Doclingに保存できる容量を超えています。文書を短くしてから保存してください。";
				if (code === "revision_conflict")
					return "別の編集が先に反映されています。入力内容を保持しているので、最新の文書を確認してください。";
				return undefined;
			},
		};
	},
	async focus(id) {
		const screen = await live.waitFor((h) => h);
		if (!screen) return false;
		screen.show(id);
		return !!(await live.waitFor((h) => h.id === id));
	},
	viewingTarget() {
		const screen = live.current();
		return screen?.visible && screen.id
			? { artifactRevisionId: screen.artifactRevisionId, targetRef: screen.id }
			: null;
	},
	viewing() {
		const screen = live.current();
		return screen?.visible && screen.id
			? formatResourceUri("markdown.document", screen.id)
			: null;
	},
};
