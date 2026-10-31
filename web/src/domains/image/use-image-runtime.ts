import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { imagePlanV2 } from "../../../../api/domains/image/contracts";
import type { EumenesClient } from "../../../../client";
import type { ArtifactEvent, Receipt } from "@eumenes/artifact-ui/contracts";
import type { ImageWorkspaceResource } from "@eumenes/artifact-ui/contracts";
import { useImageCreation } from "./use-image-creation";
import { queryRoots } from "../../queryKeys";
import type { ImageCreationOptions } from "@eumenes/design-system";
import {
	imageContentUrl,
	deleteLibraryImage,
	useImageLibrary,
} from "../../media/use-image-library";
export const imageStudioSource = "image-studio";
export function useImageRuntime(
	client: EumenesClient,
	conversationId = "main",
	onClose?: () => void,
	defaults: ImageCreationOptions["defaults"] = {
		width: 512,
		height: 512,
		format: "webp",
		seed: 0,
	},
	targetRef?: string,
) {
	const cache = useQueryClient();
	const query = useQuery({
		queryKey: [queryRoots.image, "generations", conversationId],
		queryFn: ({ signal }) => client.imageGenerations(conversationId, signal),
		refetchInterval: (q) =>
			q.state.data?.some(
				(i) => i.state === "planning" || i.state === "generating",
			)
				? 1000
				: false,
	});
	const items = query.data ?? [];
	const latest = items[0];
	const shown =
		(targetRef
			? items.find((item) => item.artifactId === targetRef)
			: undefined) ?? latest;
	const creation = useImageCreation(client, conversationId, items, latest);
	const library = useImageLibrary(client, creation.busy ? 2000 : false);
	const [selection, select] = useState<{ id?: string; latestId?: string }>();
	const seen = useRef(new Set<string>());
	const lock = useRef(false);
	const images = (library.data?.images ?? [])
		.slice()
		.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
		.map((a) => {
			const record = items.find(
				(i) => i.artifactId === a.id && i.state === "completed",
			);
			return {
				id: a.id,
				title: record?.title ?? `画像 ${a.createdAt.slice(0, 10)}`,
				width: a.width,
				height: a.height,
				format: a.format,
				createdAt: a.createdAt,
				prompt: record?.prompt ?? undefined,
				url: imageContentUrl(a.id),
			};
		});
	const resource: ImageWorkspaceResource = {
		kind: "image-workspace",
		revision: Math.max(...items.map((i) => i.updatedAt), 0) + creation.revision,
		identity: shown?.id ?? "studio",
		initialTab: shown?.action === "library" ? "history" : "create",
		title: "画像生成",
		defaults: {
			prompt: shown?.prompt ?? "",
			model: shown?.model ?? defaults.model,
			width: shown?.width ?? defaults.width,
			height: shown?.height ?? defaults.height,
			format: shown?.format ?? defaults.format,
			seed: shown?.seed ?? defaults.seed,
		},
		images,
		selectedId:
			targetRef && images.some((image) => image.id === targetRef)
				? targetRef
				: selection?.latestId === latest?.id
					? selection?.id
					: latest?.state === "completed"
						? (latest.artifactId ?? images[0]?.id)
						: undefined,
		busy: creation.busy,
		status: creation.creation.status,
		statusTitle: creation.creation.title,
		statusDescription: creation.creation.description,
		canCancel: creation.creation.canCancel,
		loading: library.isPending,
		error: library.error
			? "保存画像を取得できませんでした。一覧を更新してください。"
			: undefined,
	};
	const snapshot = { [imageStudioSource]: resource };
	async function dispatch(event: ArtifactEvent): Promise<Receipt> {
		if (
			event.source !== imageStudioSource ||
			![
				"image-generate",
				"image-cancel",
				"image-refresh",
				"image-select",
				"image-close",
				"image-delete",
			].includes(event.action)
		)
			return { status: "rejected", message: "この操作は利用できません。" };
		if (seen.current.has(event.id))
			return { status: "duplicate", message: "受付済みです。" };
		if (event.revision !== resource.revision)
			return {
				status: "conflict",
				message: "状態が更新されました。もう一度操作してください。",
			};
		if (lock.current)
			return { status: "conflict", message: "操作を受け付けています。" };
		lock.current = true;
		try {
			if (event.action === "image-close") {
				if (!onClose)
					return {
						status: "rejected",
						message: "この表示はここでは閉じられません。",
					};
				onClose();
			} else if (event.action === "image-generate") {
				if (creation.busy)
					return { status: "rejected", message: "生成中です。" };
				const plan = imagePlanV2.safeParse({
					action: "generate",
					title: "画像",
					description: "",
					prompt: event.values.prompt,
					...(event.values.model ? { model: event.values.model } : {}),
					width: Number(event.values.width),
					height: Number(event.values.height),
					format: event.values.format,
					seed: Number(event.values.seed),
				});
				if (!plan.success || !plan.data.prompt.trim())
					return {
						status: "rejected",
						message: "プロンプトと画像の設定を確認してください。",
					};
				const { prompt, model, width, height, format, seed } = plan.data;
				await creation.generate(
					JSON.stringify({ prompt, model, width, height, format, seed }),
				);
			} else if (event.action === "image-cancel") {
				if (!creation.creation.canCancel)
					return {
						status: "rejected",
						message: "取消できる生成がありません。",
					};
				await creation.cancel();
			} else if (event.action === "image-refresh") {
				await cache.invalidateQueries({ queryKey: [queryRoots.image] });
			} else if (event.action === "image-delete") {
				const image = images.find((i) => i.id === event.values.id);
				if (!image)
					return {
						status: "rejected",
						message: "画像が見つかりません。一覧を更新してください。",
					};
				if (!(await deleteLibraryImage(cache, client, image.id))) {
					return {
						status: "rejected",
						message: "削除結果を確認できませんでした。一覧を更新してください。",
					};
				}
				if (resource.selectedId === image.id) select({ latestId: latest?.id });
				seen.current.add(event.id);
				return { status: "accepted", message: "画像を削除しました。" };
			} else {
				const image = images.find((i) => i.id === event.values.id);
				if (!image)
					return { status: "rejected", message: "画像が見つかりません。" };
				select({ id: image.id, latestId: latest?.id });
			}
			seen.current.add(event.id);
			return { status: "accepted", message: "操作を受け付けました。" };
		} catch (error) {
			return {
				status: "rejected",
				message:
					error instanceof Error && error.message === "image_prompt_too_long"
						? "プロンプトが長すぎます。短くしてください。"
						: "受付を確認できませんでした。状態を更新して再試行してください。",
			};
		} finally {
			lock.current = false;
		}
	}
	return {
		runtime: { snapshot, dispatch },
		loading: query.isPending,
		error: query.error,
	};
}
