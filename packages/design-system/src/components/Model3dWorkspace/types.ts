import type { ReactNode } from "react";

export type Model3dGenerationState =
	| "submitting"
	| "queued"
	| "running"
	| "completed"
	| "failed"
	| "cancelled";

export type Model3dGenerationItem = {
	id: string;
	title: string;
	tags: readonly string[];
	sourceKind: "prompt" | "image";
	prompt?: string;
	state: Model3dGenerationState;
	/** Wording supplied by the backend. Shown as is; no progress rate is ever derived. */
	stageLabel: string;
	assetId: string | null;
	/** The finished model was deleted in LARM. */
	deleted: boolean;
	warnings: readonly string[];
	errorLabel: string | null;
};

export type Model3dAssetItem = {
	id: string;
	title: string;
	tags: readonly string[];
	/** ISO date-time. */
	createdAt: string;
	prompt: string | null;
	warnings: readonly string[];
	/** The source image shown as a thumbnail; omitted when the asset has none. */
	thumbnailUrl?: string;
	/** Same-origin GLB link. */
	downloadUrl?: string;
};

export type Model3dSourceImage = {
	id: string;
	title: string;
	thumbnailUrl?: string;
};

export type Model3dFilter = {
	q: string;
	tags: string[];
	sort: "createdAt" | "relevance";
	order: "asc" | "desc";
};

/** Exactly one of `prompt` and `imageId` is non-empty. `tags` is comma separated text. */
export type Model3dGenerateValues = {
	title: string;
	tags: string;
	prompt: string;
	imageId: string;
};

export type Model3dUpdateValues = { id: string; title: string; tags: string };

/** `true` tells the form the request was accepted, so it can clear itself. */
export type Model3dSubmitResult = boolean | void | Promise<boolean | void>;

export type Model3dWorkspaceProps = {
	available: boolean;
	unavailableReason?: string | null;
	generations: readonly Model3dGenerationItem[];
	highlightedGenerationId?: string;
	sourceImages: readonly Model3dSourceImage[];
	sourceImagesLoading?: boolean;
	assets: readonly Model3dAssetItem[];
	total?: number;
	hasMore: boolean;
	loading?: boolean;
	error?: string;
	filter: Model3dFilter;
	selectedAsset?: Model3dAssetItem;
	/** Places the host-owned 3D viewer for the selected asset. */
	renderViewer?: (assetId: string) => ReactNode;
	pending?: boolean;
	message?: string;
	onGenerate: (values: Model3dGenerateValues) => Model3dSubmitResult;
	onCancel: (id: string) => void;
	onRecheck: (id: string) => void;
	onSelect: (id: string) => void;
	onDelete: (id: string) => void;
	onUpdate: (values: Model3dUpdateValues) => Model3dSubmitResult;
	onSearch: (filter: Model3dFilter) => void;
	onMore: () => void;
	onRefresh: () => void;
};

export const model3dQualityNote =
	"生成結果は、テクスチャが暗くなる、顔が崩れるなどの品質の問題が出ることがあります。編集には Blender 4.0 以上、または WebP テクスチャに対応したビューアをお勧めします。";
