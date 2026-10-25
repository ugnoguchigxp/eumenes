import type { Definition } from "../contracts";
import {
	resourceActionsItemId,
	resourceKindItemId,
	type ResourceActionName,
	type ResourceActionWords,
	type ResourceKindRegistration,
} from "../contracts/resource-kinds";

/**
 * The resource kinds of spec/resource-uri-implementation-plan-2026-10-25.md §2.2. A new kind is a new
 * `resource-kind` item (here or in a bundle); no code branches on a kind name. `producedBy` lists the
 * toolchain ids whose results create the kind; the host creates `todo` and `event` itself.
 */
type Row = {
	kind: string;
	label: string;
	owner: string;
	actions: ResourceActionName[];
	defaultAction: ResourceActionName;
	producedBy: string[];
	summary: string;
};

const rows: Row[] = [
	{
		kind: "image",
		label: "画像",
		owner: "image",
		actions: ["open", "read"],
		defaultAction: "open",
		producedBy: ["image.create"],
		summary: "生成した画像",
	},
	{
		kind: "music.track",
		label: "曲",
		owner: "music",
		actions: ["open", "play", "read"],
		defaultAction: "play",
		producedBy: ["music.create"],
		summary: "生成した曲",
	},
	{
		kind: "music.playlist",
		label: "プレイリスト",
		owner: "music",
		// Readable (its track titles), so it can be handed to a sub-agent as a reference.
		actions: ["open", "play", "read"],
		defaultAction: "play",
		producedBy: ["music.library"],
		summary: "曲のプレイリスト",
	},
	{
		kind: "model3d.asset",
		label: "3Dモデル",
		owner: "model3d",
		actions: ["open", "read"],
		defaultAction: "open",
		producedBy: ["model3d.studio"],
		summary: "生成した3Dモデル",
	},
	{
		kind: "drawing",
		label: "図",
		owner: "excalidraw",
		actions: ["open", "read"],
		defaultAction: "open",
		producedBy: ["excalidraw.edit"],
		summary: "描いた図",
	},
	{
		kind: "ui.composition",
		label: "画面",
		owner: "ui-compositions",
		actions: ["open", "read"],
		defaultAction: "open",
		producedBy: ["ui.compose"],
		summary: "組み立てた画面",
	},
	{
		kind: "report",
		label: "調査報告",
		owner: "web-research",
		actions: ["open", "read"],
		defaultAction: "read",
		producedBy: ["web.search", "web.service-search", "history.research"],
		summary: "Web調査と会話履歴調査の報告",
	},
	{
		kind: "compute.result",
		label: "計算結果",
		owner: "compute",
		actions: ["open", "read"],
		defaultAction: "read",
		producedBy: ["compute.python"],
		summary: "計算の結果",
	},
	{
		kind: "capture",
		label: "撮影",
		owner: "browser",
		actions: ["open", "read"],
		defaultAction: "open",
		producedBy: ["browser.capture"],
		summary: "ブラウザで撮影した画面",
	},
	{
		kind: "document",
		label: "読み取った文書",
		owner: "ocr",
		actions: ["open", "read"],
		defaultAction: "open",
		producedBy: ["ocr.manage"],
		summary: "OCRで読み取った文書",
	},
	{
		kind: "pipeline",
		label: "手順",
		owner: "pipelines",
		actions: ["open", "read"],
		defaultAction: "open",
		producedBy: ["pipeline.studio"],
		summary: "登録した手順",
	},
	{
		kind: "code.task",
		label: "コード作業",
		owner: "codex-tasks",
		actions: ["open", "read"],
		defaultAction: "read",
		producedBy: [
			"codex-tasks.manage",
			"kanban.manage",
			"claude-code.request",
			"cli.run",
		],
		summary: "コード作業の依頼と結果",
	},
	{
		kind: "event",
		label: "会話の出来事",
		owner: "continuity",
		actions: ["read"],
		defaultAction: "read",
		producedBy: [],
		summary: "会話の出来事の記録",
	},
];

const base = (): Pick<
	Definition,
	"revision" | "aliases" | "tags" | "useWhen" | "avoidWhen" | "dependencies"
> => ({
	revision: 1,
	aliases: [],
	tags: [],
	useWhen: [],
	avoidWhen: [],
	dependencies: [],
});

/** The words of the actions, which a kind's `actionLabels` overrides per kind. */
const actionWords: ResourceActionWords = {
	version: 1,
	words: { open: "表示する", play: "再生する", read: "内容を伝える" },
};

export const resourceKindBuiltins: Definition[] = [
	{
		...base(),
		kind: "resource-actions",
		id: resourceActionsItemId,
		title: "操作の言葉",
		summary: "リソースの操作ごとの言葉（次の行動の表示に使う）",
		resourceKindData: actionWords,
	},
	...rows.map((row): Definition => {
		const data: ResourceKindRegistration = {
			version: 1,
			label: row.label,
			owner: row.owner,
			actions: row.actions,
			defaultAction: row.defaultAction,
			producedBy: row.producedBy,
		};
		return {
			...base(),
			kind: "resource-kind",
			id: resourceKindItemId(row.kind),
			title: row.label,
			summary: row.summary,
			resourceKindData: data,
		};
	}),
];
