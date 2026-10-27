import {
	Model3dWorkspace,
	type Model3dWorkspaceProps,
} from "@eumenes/design-system";
import type { ArtifactRequest } from "./contracts";
import { isSafeImageUrl } from "./contracts";
import { useAction } from "./components";
import { useArtifactRuntime } from "./runtime";

/** What the host supplies for the 3D model screen; operations come from dispatch. */
export type Model3dWorkspaceResource = Pick<
	Model3dWorkspaceProps,
	| "available"
	| "unavailableReason"
	| "generations"
	| "highlightedGenerationId"
	| "sourceImages"
	| "sourceImagesLoading"
	| "sourceImagesError"
	| "focus"
	| "assets"
	| "total"
	| "hasMore"
	| "loading"
	| "error"
	| "filter"
	| "selectedAsset"
> & { kind: "model3d"; revision: number };

const assetPath = (leaf: "content" | "source") =>
	new RegExp(`^/api/model3d/assets/[A-Za-z0-9][A-Za-z0-9._-]{0,127}/${leaf}$`);
const downloadPath = assetPath("content");
const sourcePath = /^\/api\/images\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/content$/;

/** URLs are supplied by the authorized host, never by the UI JSON. */
const safeThumbnail = (url: string | undefined) =>
	url && (isSafeImageUrl(url) || sourcePath.test(url)) ? url : undefined;
const safeDownload = (url: string | undefined) =>
	url && downloadPath.test(url) ? url : undefined;

/** The host owns the WebGL viewer; this view only places it. */
export function Model3dWorkspaceView({
	request,
}: {
	request: ArtifactRequest;
}) {
	const action = useAction(request);
	const runtime = useArtifactRuntime();
	const resource = action.resource;
	if (resource?.kind !== "model3d") return null;
	const viewer = runtime.hostViews?.["model3d-viewer"];
	const thumbnail = runtime.hostViews?.["model3d-thumbnail"];
	const asset = (item: Model3dWorkspaceProps["assets"][number]) => ({
		...item,
		thumbnailUrl: safeThumbnail(item.thumbnailUrl),
		downloadUrl: safeDownload(item.downloadUrl),
	});
	return (
		<Model3dWorkspace
			available={resource.available}
			unavailableReason={resource.unavailableReason}
			generations={resource.generations}
			highlightedGenerationId={resource.highlightedGenerationId}
			sourceImages={resource.sourceImages.map((image) => ({
				...image,
				thumbnailUrl: safeThumbnail(image.thumbnailUrl),
			}))}
			sourceImagesLoading={resource.sourceImagesLoading}
			sourceImagesError={resource.sourceImagesError}
			onDeleteImage={runtime.deleteLibraryImage}
			onUploadImage={
				runtime.uploadFile
					? async (file, requestId, signal) => {
							const receipt = await runtime.uploadFile!(
								action.source,
								file,
								{ requestId },
								signal,
							);
							if (receipt.status === "accepted" && receipt.value)
								return {
									status: "succeeded",
									image: {
										id: receipt.value,
										title: "アップロードした画像",
										thumbnailUrl: `/api/images/${encodeURIComponent(receipt.value)}/content`,
									},
								};
							return receipt.status === "pending" ||
								receipt.status === "indeterminate"
								? { status: "pending", message: receipt.message }
								: {
										status: "failed",
										message: receipt.message,
										canRetry: receipt.canRetry,
									};
						}
					: undefined
			}
			renderGooglePhotos={
				runtime.hostViews?.["image-picker-photos"]
					? (onSelect) =>
							runtime.hostViews!["image-picker-photos"]!({ onSelect })
					: undefined
			}
			focus={resource.focus}
			assets={resource.assets.map(asset)}
			total={resource.total}
			hasMore={resource.hasMore}
			loading={resource.loading}
			error={resource.error}
			filter={resource.filter}
			selectedAsset={resource.selectedAsset && asset(resource.selectedAsset)}
			renderThumbnail={
				thumbnail ? (assetId) => thumbnail({ assetId }) : undefined
			}
			renderViewer={(assetId) =>
				viewer ? (
					viewer({ assetId })
				) : (
					<p>この画面では3D表示を利用できません。</p>
				)
			}
			pending={action.pending}
			message={action.message}
			onGenerate={(values) => action.send("model3d-generate", { ...values })}
			onUpdate={(values) => action.send("model3d-update", { ...values })}
			onCancel={(id) => {
				void action.send("model3d-cancel", { id });
			}}
			onRecheck={(id) => {
				void action.send("model3d-recheck", { id });
			}}
			onSelect={(id) => {
				void action.send("model3d-select", { id });
			}}
			onDelete={(id) => {
				void action.send("model3d-delete", { id });
			}}
			onSearch={(filter) => {
				void action.send("model3d-search", {
					query: filter.q,
					tags: filter.tags.join(","),
					sort: filter.sort,
					order: filter.order,
				});
			}}
			onMore={() => {
				void action.send("model3d-more", {});
			}}
			onRefresh={() => {
				void action.send("model3d-refresh", {});
			}}
		/>
	);
}
