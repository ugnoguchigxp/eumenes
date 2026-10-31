import type { DotsMessagingResource } from "./dots-messaging-components";
import type { WorkMenuResource, WorkResultResource } from "./work-components";
export type { WorkMenuResource, WorkResultResource } from "./work-components";
import type { GoogleAccountsResource } from "./google-accounts-components";
import type { OcrResource } from "./ocr-components";
export type { OcrResource } from "./ocr-components";
import type { CollectionResource } from "./collection-contracts";
export type * from "./resource-exports";
import type { ObjectRecognitionResource } from "./object-recognition-components";
import type { TerminalsResource } from "./terminal-components";
import type { KanbanResource } from "./kanban-components";
import type { ActivityResource } from "./activity-components";
export type { KanbanBoardSource, KanbanResource } from "./kanban-components";
export type {
	TerminalConnection,
	TerminalSessionResource,
	TerminalsResource,
} from "./terminal-components";
export type { ObjectRecognitionResource } from "./object-recognition-components";
import type { DrawingResource } from "./drawing-components";
import { z } from "zod";
import { compositionModel, expression } from "./composition-contracts";
import type { ImageWorkspaceResource } from "./image-components";
export type { ImageWorkspaceResource } from "./image-components";
export type { Model3dWorkspaceResource } from "./model3d-components";
export type { BrowserWorkspaceResource } from "./browser-components";
import type { RecordsResource } from "./records-components";
import type { TodoResource } from "./todo-components";
export type { TodoResource } from "./todo-components";
import type { Model3dWorkspaceResource } from "./model3d-components";
import type { BrowserWorkspaceResource } from "./browser-components";
import type { MusicResource, GenerationResource } from "./media-contracts";
import type { UiStudioResource } from "./ui-studio-contracts";
import type { PipelineStudioResource } from "./pipeline-studio-contracts";
import type {
	SettingsSectionResource,
	SettingsNavigationResource,
	SettingsChangesResource,
	SubtitlePreviewResource,
} from "./settings-contracts";
export type { MusicResource, GenerationResource } from "./media-contracts";

import {
	field,
	question,
	source,
	title,
	viewRegistry,
} from "./contracts-views";
export { viewRegistry };
import type { ComputeWorkspaceResource } from "./compute-components";
export type { ComputeWorkspaceResource } from "./compute-components";

const layoutGaps = ["compact", "normal", "relaxed"] as const;
const layoutWidths = ["narrow", "normal", "wide"] as const;
/** Nested layouts: root included, at most this deep and this many views per definition. */
const maxLayoutDepth = 6;
const maxDefinitionViews = 240;
export type View = keyof typeof viewRegistry;
export type ArtifactRequest = {
	[K in View]: z.infer<(typeof viewRegistry)[K]["schema"]>;
}[View];
export type Field = z.infer<typeof field>;
export type QuestionData = z.infer<typeof question>;
export const maxDefinitionBytes = 98_304;
export function parseRequest(value: unknown): ArtifactRequest {
	if (
		!value ||
		typeof value !== "object" ||
		!("view" in value) ||
		typeof value.view !== "string" ||
		!Object.hasOwn(viewRegistry, value.view)
	)
		throw new Error("未登録の表示です");
	return viewRegistry[value.view as View].schema.parse(value);
}
const layoutShape = z.strictObject({
	view: z.literal("layout"),
	direction: z
		.enum(["stack", "grid", "tabs", "form-preview", "slides"])
		.default("stack"),
	/** The composition's shared state; the outermost layout only (`validateComposition`). */
	model: compositionModel.optional(),
	/** Shows the children only while this expression is true. */
	when: expression.optional(),
	appearance: z.enum(["clean", "warm", "elegant", "friendly"]).optional(),
	gap: z.enum(layoutGaps).optional(),
	width: z.enum(layoutWidths).optional(),
	title,
	draftSource: source.optional(),
	headerChildren: z.array(z.number().int().min(0).max(11)).max(12).optional(),
	headerLayout: z.enum(["stack", "inline"]).optional(),
	tabs: z
		.array(
			z.strictObject({
				label: z.string().min(1).max(80),
				children: z.array(z.number().int().min(0).max(11)).min(1),
				/** `form-preview` shows the tab's subtitle preview inside its settings section. */
				arrangement: z.enum(["form-preview"]).optional(),
			}),
		)
		.min(1)
		.max(12)
		.optional(),
});
export type Layout = z.infer<typeof layoutShape> & {
	children: Array<ArtifactRequest | Layout>;
};
/** Depth (this node = 1) and number of views of a definition subtree, layouts included. */
function layoutExtent(node: ArtifactRequest | Layout): {
	depth: number;
	views: number;
} {
	if (node.view !== "layout") return { depth: 1, views: 1 };
	let depth = 0;
	let views = 1;
	for (const child of node.children) {
		const extent = layoutExtent(child);
		depth = Math.max(depth, extent.depth);
		views += extent.views;
	}
	return { depth: depth + 1, views };
}
function refineLayout(value: Layout, context: z.RefinementCtx) {
	const extent = layoutExtent(value);
	if (extent.depth > maxLayoutDepth)
		context.addIssue({
			code: "custom",
			message: `layout nesting is limited to ${maxLayoutDepth} levels`,
		});
	if (extent.views > maxDefinitionViews)
		context.addIssue({
			code: "custom",
			message: `a definition holds at most ${maxDefinitionViews} views`,
		});
	if (
		value.draftSource &&
		(value.direction !== "tabs" ||
			!value.children.some(
				(child) =>
					child.view === "settings-section" &&
					child.source === value.draftSource,
			))
	)
		context.addIssue({
			code: "custom",
			message: "draftSource must name a settings section in tabs",
		});
	if (
		value.direction === "form-preview" &&
		(value.children.length !== 2 ||
			value.children[0]?.view !== "settings-section" ||
			value.children[1]?.view !== "subtitle-preview")
	)
		context.addIssue({
			code: "custom",
			message: "form-preview requires a settings section and subtitle preview",
		});
	for (const tab of value.tabs ?? [])
		if (
			tab.arrangement === "form-preview" &&
			(tab.children.length !== 2 ||
				value.children[tab.children[0]!]?.view !== "settings-section" ||
				value.children[tab.children[1]!]?.view !== "subtitle-preview")
		)
			context.addIssue({
				code: "custom",
				message:
					"form-preview requires a settings section and subtitle preview",
			});
	if (value.headerChildren && value.direction !== "tabs")
		context.addIssue({
			code: "custom",
			message: "headerChildren requires tabs",
		});
	if (value.headerChildren && !value.tabs)
		context.addIssue({
			code: "custom",
			message: "headerChildren requires explicit tabs",
		});
	if (!value.tabs) return;
	const indexes = [
		...(value.headerChildren ?? []),
		...value.tabs.flatMap((tab) => tab.children),
	];
	if (
		value.direction !== "tabs" ||
		indexes.length !== value.children.length ||
		new Set(indexes).size !== value.children.length ||
		indexes.some((index) => index >= value.children.length)
	)
		context.addIssue({
			code: "custom",
			message: "tabs must contain each child exactly once",
		});
}
export const layoutSchema: z.ZodType<Layout> = z.lazy(() =>
	layoutShape
		.extend({
			children: z
				.array(
					z.union([
						...Object.values(viewRegistry).map((v) => v.schema),
						layoutSchema,
					]),
				)
				.min(1)
				.max(48),
		})
		.superRefine(refineLayout),
);
export type ArtifactDefinition = ArtifactRequest | Layout;
export function parseDocument(value: unknown): ArtifactDefinition {
	if (
		value &&
		typeof value === "object" &&
		"view" in value &&
		value.view === "layout"
	)
		return layoutSchema.parse(value);
	return parseRequest(value);
}
export function definitionRequests(
	definition: ArtifactDefinition,
): ArtifactRequest[] {
	return definition.view === "layout"
		? definition.children.flatMap(definitionRequests)
		: [definition];
}
export function definitionName(definition: ArtifactDefinition): string {
	return definition.view === "layout"
		? "Composition"
		: viewRegistry[definition.view].name;
}
export function parseDefinition(input: string): ArtifactDefinition {
	if (new TextEncoder().encode(input).length > maxDefinitionBytes)
		throw new Error("定義が大きすぎます（96KBまで）");
	return parseDocument(JSON.parse(input));
}

const SAFE_DATA_IMAGE = /^data:image\/(?:png|jpeg|webp|svg\+xml);/i;
/** Only https:, blob: and a short list of raster/SVG data: URLs may be shown as an image. */
export function isSafeImageUrl(value: string): boolean {
	return /^(?:https:|blob:)/i.test(value) || SAFE_DATA_IMAGE.test(value);
}
export const imageUrlSchema = z.string().refine(isSafeImageUrl, {
	message: "unsafe_image_url",
});
export type ImageResource = {
	kind: "generated-image";
	revision: number;
	status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
	url?: string;
	mimeType?: string;
	alt: string;
};
const IMAGE_EXTENSIONS: Record<string, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/jpg": "jpg",
	"image/webp": "webp",
	"image/svg+xml": "svg",
};
/** Download name derived from the mime type, else the data: header or URL extension. */
export function imageDownloadName(image: {
	url?: string;
	mimeType?: string;
}): string {
	const mime = (
		image.mimeType ?? /^data:([^;,]+)/i.exec(image.url ?? "")?.[1]
	)?.toLowerCase();
	let ext = mime ? IMAGE_EXTENSIONS[mime] : undefined;
	if (!ext && image.url && !image.url.startsWith("data:")) {
		const path = image.url.split(/[?#]/)[0] ?? "";
		const found = /\.(png|jpe?g|webp|svg)$/i.exec(path)?.[1]?.toLowerCase();
		ext = found === "jpeg" ? "jpg" : found;
	}
	return ext ? `generated-image.${ext}` : "generated-image";
}
export type QuestionResource = {
	kind: "question";
	revision: number;
	status: "open" | "answered" | "expired";
	question: QuestionData;
	answer?: string;
};
export type FormResource = {
	kind: "form";
	revision: number;
	submitLabel?: string;
	fields: Field[];
	defaults: Record<string, string | boolean>;
	submitted?: Record<string, string | boolean>;
};
export type MemoryResource = {
	kind: "memory";
	revision: number;
	entries: { id: string; text: string; selected: boolean }[];
};
export type SettingsResource = {
	kind: "settings";
	revision: number;
	theme: "light" | "dark";
	autoSpeak: boolean;
	volume: number;
};
export type Resource =
	| UsageDashboardResource
	| {
			kind: "external-app-launcher";
			revision: number;
			available: boolean;
			busy: boolean;
			preparing?: boolean;
			error?: string;
	  }
	| WorkMenuResource
	| WorkResultResource
	| GoogleAccountsResource
	| DotsMessagingResource
	| ObjectRecognitionResource
	| TerminalsResource
	| KanbanResource
	| ActivityResource
	| ImageWorkspaceResource
	| Model3dWorkspaceResource
	| ComputeWorkspaceResource
	| BrowserWorkspaceResource
	| RecordsResource
	| TodoResource
	| SubtitlePreviewResource
	| SettingsSectionResource
	| SettingsNavigationResource
	| SettingsChangesResource
	| {
			kind: "timer-workspace";
			revision: number;
			state:
				| "setup"
				| "active"
				| "paused"
				| "confirming"
				| "elapsed"
				| "cancelled";
			durationSeconds?: number;
			remainingSeconds?: number;
			title?: string;
			dueAt?: string;
			finishLabel?: string;
			durationLabel?: string;
			canCreate?: boolean;
			mode?: "timer" | "stopwatch";
			stopwatch?: { elapsedMs: number; running: boolean };
	  }
	| OcrResource
	| DrawingResource
	| MusicResource
	| GenerationResource
	| ImageResource
	| QuestionResource
	| CollectionResource
	| FormResource
	| UiStudioResource
	| PipelineStudioResource
	| MemoryResource
	| SettingsResource
	| { kind: "components"; revision: number; example?: string };
export type Snapshot = Readonly<Record<string, Resource>>;
export type { ArtifactEvent } from "./event-contracts";
export type { Receipt } from "./receipt-contracts";

export type { ActivityResource } from "./activity-components";
import type { UsageDashboardResource } from "./usage-components";
export type { UsageDashboardResource } from "./usage-components";
