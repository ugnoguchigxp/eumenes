export * from "./script";
export * from "./history";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { variableNamePattern } from "./history";
import type { CaptureRange, DriverDisconnectReason } from "./ports";
import type { HttpErrorStatus } from "../../../infrastructure/http";

/** What the host lets the model see of one snapshot (spec §5.5); the rest is not actionable. */
export const SNAPSHOT_MAX_BYTES = 32 * 1024;
export const SNAPSHOT_MAX_DEPTH = 12;
export const SNAPSHOT_MAX_REFS = 200;
/** Each side of a capture, in pixels; 2500 passes and 2501 is refused (spec §6.2). */
export const CAPTURE_MAX_SIDE = 2500;
/** A tab lease is renewed every `LEASE_RENEW_MS` while an operation runs and never outlives its task. */
export const LEASE_MS = 30_000;
export const LEASE_RENEW_MS = 10_000;
export const TASK_MS = 10 * 60_000;
export const CAPTURE_MS = 2 * 60_000;
export const GRANT_MS = 10 * 60_000;
/** An approval the user gave (or that waits for it) lives this long and is used once. */
export const APPROVAL_MS = 10 * 60_000;
export const APPROVAL_LIMIT = 5;
/** Ended tasks, their operations, grants and approvals are deleted after this long. */
export const RETENTION_MS = 7 * 24 * 60 * 60_000;
export const ACTIVE_TASK_LIMIT = 3;
export const ACTIVE_CAPTURE_LIMIT = 3;
export const SUMMARY_CHARS = 160;

export const tabRefSchema = z.uuid();
export const observationRefSchema = z.uuid();
/** MCP element refs look like `e12`. */
export const elementRefSchema = z.string().regex(/^[A-Za-z0-9_-]{1,32}$/);
export const captureRangeSchema = z.enum(["viewport", "full-page", "element"]);

export const captureStart = z
	.strictObject({
		requestId: z.uuid(),
		tabRef: tabRefSchema,
		range: captureRangeSchema,
		elementRef: elementRefSchema.optional(),
		observationRef: observationRefSchema.optional(),
	})
	.refine(
		(c) =>
			c.range === "element"
				? !!c.elementRef && !!c.observationRef
				: !c.elementRef && !c.observationRef,
		"element_ref_mismatch",
	);
export type CaptureStart = z.infer<typeof captureStart>;

/** The Brave executable: an absolute path; empty clears the setting. */
export const settingSave = z.strictObject({
	executablePath: z
		.string()
		.trim()
		.max(1024)
		.refine(
			(p) => p === "" || (isAbsolute(p) && !p.includes("\0")),
			"path_not_absolute",
		),
});

export const connectionStates = [
	"disconnected",
	"connecting",
	"connected",
	"failed",
] as const;
export type ConnectionState = (typeof connectionStates)[number];
/** The ends the host records beyond the driver's own reasons. */
export type ConnectionEndReason = DriverDisconnectReason | "backend_restart";

export const taskStates = [
	"queued",
	"running",
	"completed",
	"needs_input",
	"failed",
	"cancelled",
	"expired",
	"indeterminate",
] as const;
export type TaskState = (typeof taskStates)[number];
export const activeTaskStates: readonly TaskState[] = ["queued", "running"];
export type TerminalTaskState = Exclude<TaskState, "queued" | "running">;

export const operationStates = [
	"prepared",
	"dispatched",
	"observed",
	"indeterminate",
	"failed",
] as const;
export type OperationState = (typeof operationStates)[number];

export const captureStates = [
	"queued",
	"capturing",
	"encoding",
	"local_ready",
	"failed",
	"cancelled",
	"expired",
] as const;
export type CaptureState = (typeof captureStates)[number];
export const activeCaptureStates: readonly CaptureState[] = [
	"queued",
	"capturing",
	"encoding",
];

/** The tool kinds the ledger records; each maps to one host-allowed MCP tool in the adapter. */
export type ToolKind = PageOperation["kind"];

const operationText = (max: number) => z.string().min(1).max(max);
/**
 * The model's own statement of what an operation does: navigate, input or commit (sends, buys, deletes,
 * saves). The host also judges forms itself (spec §5.3); `commit` covers what only scripts can submit.
 */
export const effects = ["navigate", "input", "commit"] as const;
export type Effect = (typeof effects)[number];
const commitEffect = { effect: z.enum(effects).optional() };
const elementTarget = {
	observationRef: observationRefSchema,
	ref: elementRefSchema,
	/** The human description of the element, as the model read it from the observation. */
	element: operationText(200),
};
/**
 * One operation on a tab. Element refs always come with the observation they were read from, and typed
 * text only as an `inputValueRef` the host issued for the task.
 */
export const pageOperation = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("navigate"), url: operationText(2048) }),
	z.strictObject({ kind: z.literal("back") }),
	z.strictObject({
		kind: z.literal("click"),
		...elementTarget,
		...commitEffect,
	}),
	z.strictObject({ kind: z.literal("hover"), ...elementTarget }),
	z.strictObject({
		kind: z.literal("type"),
		...elementTarget,
		inputValueRef: z.uuid(),
		purpose: operationText(60),
		submit: z.boolean(),
		...commitEffect,
	}),
	z.strictObject({
		kind: z.literal("select"),
		...elementTarget,
		values: z.array(operationText(500)).min(1).max(20),
	}),
	z.strictObject({
		kind: z.literal("press"),
		key: z.string().regex(/^[A-Za-z0-9+]{1,40}$/),
		...commitEffect,
	}),
	z
		.strictObject({
			kind: z.literal("wait"),
			text: operationText(200).optional(),
			textGone: operationText(200).optional(),
			seconds: z.number().gt(0).max(30).optional(),
		})
		.refine((w) => w.text || w.textGone || w.seconds, "wait_condition"),
	z.strictObject({ kind: z.literal("tab_new"), url: operationText(2048) }),
	z.strictObject({ kind: z.literal("tab_close") }),
	z.strictObject({ kind: z.literal("tab_select") }),
]);
export type PageOperation = z.infer<typeof pageOperation>;

export type OperationOutcome = {
	operationId: string;
	state: Exclude<OperationState, "prepared" | "dispatched">;
	/** The tab the operation ended on (the new one for `tab_new`). */
	tabRef?: string;
	url?: string;
	title?: string;
	errorCode?: string;
};

export type Observation = {
	blocks?: { blockRef: string; text: string }[];
	/** Links present in this bounded observation; no relevance or item-type classification. */
	links?: { blockRef: string; title: string; url: string }[];
	observationRef: string;
	tabRef: string;
	generation: number;
	url: string;
	title: string;
	/** The bounded snapshot text; only refs inside it are actionable. */
	text: string;
	truncated: boolean;
	reasons: ("bytes" | "depth" | "refs")[];
	refCount: number;
};

/** `history_variable`: a Script variable of a history this task follows, typed without asking (spec browser-run-history §5.1). */
export type GrantProvenance = "request" | "user_approved" | "history_variable";

export const approvalKinds = ["operation", "input_value"] as const;
export type ApprovalKind = (typeof approvalKinds)[number];
export const approvalStates = [
	"pending",
	"approved",
	"consumed",
	"expired",
] as const;
export type ApprovalState = (typeof approvalStates)[number];
export type ApprovalAction = "click" | "press" | "type";

/**
 * An operation the user must confirm before the host runs it (spec §5.3). It names the tab, the page
 * (origin and path only), the kind of action and the element as the model described it; `summary` is what
 * the user is shown. `valueDigest` ties a typed value to the approval without keeping the value.
 */
export type ApprovalRequest = {
	kind: "operation";
	tabRef: string;
	url: string;
	action: ApprovalAction;
	element: string;
	summary: string;
	valueDigest?: string;
};
/** A value the request did not contain, which the user may allow the task to type (becomes a `user_approved` grant). */
export type InputValueApproval = {
	kind: "input_value";
	value: string;
	origin: string;
	purpose: string;
	/** The Script variable the value is for; kept so the approved input stays a variable of the history. */
	variable?: string;
};
export const approvalRequestSchema = z.strictObject({
	kind: z.literal("operation"),
	tabRef: tabRefSchema,
	url: z.string().max(2048),
	action: z.enum(["click", "press", "type"]),
	element: z.string().min(1).max(200),
	summary: z.string().min(1).max(SUMMARY_CHARS),
	valueDigest: z.string().max(128).optional(),
});
export const inputValueApprovalSchema = z.strictObject({
	kind: z.literal("input_value"),
	value: z.string().min(1).max(2000),
	origin: z.string().min(1).max(2048),
	purpose: z.string().min(1).max(60),
	variable: z.string().regex(variableNamePattern).optional(),
});
/** What an approved, unused approval lets the task do now; `inputValueRef` is the grant a value approval became. */
export type ApprovedItem =
	| (Omit<ApprovalRequest, "valueDigest"> & { approvalId: string })
	| {
			kind: "input_value";
			approvalId: string;
			inputValueRef: string;
			origin: string;
			purpose: string;
			summary: string;
	  };

/** Thrown by `operate` when the host needs the user's approval and none was given; nothing was dispatched. */
export class BrowserApprovalRequired extends Error {
	readonly code = "approval_required";
	constructor(readonly request: ApprovalRequest) {
		super("approval_required");
		this.name = "BrowserApprovalRequired";
	}
}

export type BrowserAvailability =
	| { available: true }
	| { available: false; reason: string };

export type ConnectionView = {
	connectionId: string | null;
	state: ConnectionState;
	startedAt: string | null;
	connectedAt: string | null;
	endedAt: string | null;
	endReason: string | null;
	configured: boolean;
	autoConnectAvailable?: boolean;
	availability: BrowserAvailability;
};

export type TabView = {
	tabRef: string;
	title: string;
	url: string;
	active: boolean;
	status: "idle" | "busy" | "closed" | "blocked";
	currentTaskLabel?: string;
};

export type OperationView = {
	sequence: number;
	scriptRevision: number | null;
	stepId: string | null;
	observedAt: number;
	observationRef: string | null;
	errorLabel: string | null;
	operationId: string;
	toolKind: ToolKind;
	state: OperationState;
	errorCode: string | null;
};

export type TaskPhase =
	| "preparing"
	| "thinking"
	| "connecting"
	| "observing"
	| "operating"
	| "capturing";

export type TaskView = {
	phase: TaskPhase | null;
	operations?: OperationView[];
	taskId: string;
	conversationId: string;
	continuedFrom: string | null;
	script: import("./script").ScriptView | null;
	/** The history the last Script follows, while it exists. */
	history?: { historyId: string; title: string };
	requestSummary: string;
	state: TaskState;
	resultSummary?: string;
	errorCode: string | null;
	errorLabel: string | null;
	tabRef: string | null;
	origin: "conversation" | "screen" | "child" | "task";
	createdAt: number;
	updatedAt: number;
	revision: number;
};

export type CaptureView = {
	captureId: string;
	range: CaptureRange;
	capturedAt: string;
	width: number;
	height: number;
	bytes: number;
	reductionPercent: number;
	state: CaptureState;
	taskId: string | null;
	errorCode: string | null;
	errorLabel: string | null;
	revision: number;
};

/** A finished task or capture reported into the conversation that asked for it. */
export type BrowserCompletion = {
	id: string;
	conversationId: string;
	message: string;
	/** ISO time, as conversation messages carry it. */
	at: string;
};

const unavailableReasons = {
	browser_not_configured: "Braveの実行ファイルが設定されていません",
	browser_disconnected: "ブラウザに接続されていません",
	browser_connecting: "ブラウザへ接続しています。Braveでタブを選んでください",
	browser_connect_timeout:
		"接続の待ち時間を超えました。もう一度接続してください",
	browser_mcp_unavailable: "ブラウザ操作の部品を起動できません",
} as const;

const errorLabels: Record<string, string> = {
	script_not_ready: "実行Scriptがまだ公開されていません",
	script_revision_conflict:
		"Scriptが更新されたため、現在の予定を確認してください",
	script_revision_limit: "Scriptの更新回数の上限に達しました",
	script_evidence_invalid: "手順の完了を確認できる最新の観測がありません",
	script_title_has_value:
		"Scriptの名称に変数の値が含まれています。手続きを表す名称にしてください",
	script_variable_unknown: "Scriptに宣言されていない変数です",
	browser_history_not_found: "履歴が見つかりません",
	browser_history_conflict: "履歴が更新されました。読み直してください",
	browser_manual_connection_required:
		"設定または接続画面でブラウザへの接続を確認してください",
	...unavailableReasons,
	tab_lost: "対象のタブが見つかりません。タブ一覧を取り直してください",
	tab_busy: "このタブは別の作業が使っています",
	lease_lost: "タブの使用権を失いました",
	observation_stale: "ページが変わったため、もう一度観測が必要です",
	ref_not_actionable: "観測に含まれない要素は操作できません",
	capture_dimensions_exceeded: "撮影範囲が大きすぎます（各辺2500pxまで）",
	capture_tab_changed: "撮影中にページが変わりました",
	capture_encoding_invalid: "画像の変換結果を確認できませんでした",
	capture_empty: "撮影範囲が空です",
	capture_failed: "撮影できませんでした",
	navigation_invalid_url: "開けないURLです",
	navigation_scheme_blocked: "httpとhttps以外は開けません",
	navigation_credentials_blocked: "認証情報を含むURLは開けません",
	navigation_private_blocked: "ローカルや社内のアドレスは開けません",
	navigation_api_blocked: "EumenesのAPIのアドレスは開けません",
	navigation_unresolved_blocked: "ホスト名を確認できないため開けません",
	tab_blocked: "このタブは開けないページを表示しているため使えません",
	approval_required: "この操作は利用者の確認が必要です",
	turn_limit: "作業の回数の上限に達したため止まりました",
	invalid_contract: "操作の指示を解釈できませんでした",
	invoke_on_last_call: "最後の一手で操作が指示されたため止まりました",
	tool_refused: "この操作は許可されていないため実行しませんでした",
	observation_budget_exceeded: "ページの情報が大きすぎて扱えません",
	capability_unavailable: "ブラウザ操作は今は使えません",
	permission_revoked: "操作の権限が取り消されました",
	grant_not_found: "入力に使える値が見つかりません",
	grant_expired: "入力に使える値の有効期限が切れました",
	grant_mismatch: "入力先のサイトまたは用途が許可と一致しません",
	operation_indeterminate: "操作が実行されたか確認できません",
	browser_task_failed: "ブラウザの操作を完了できませんでした",
	browser_driver_failed: "ブラウザとの通信に失敗しました",
	task_expired: "作業の時間切れです",
	task_interrupted: "作業が中断されました",
	task_not_active: "作業はすでに終わっています",
	task_indeterminate: "実行済みか確認できない操作があるため止まりました",
};
export const errorLabel = (code: string | null) =>
	code ? (errorLabels[code] ?? "ブラウザの操作に失敗しました") : null;

/** The reason shown while the browser cannot be used; the last connection explains a stopped state. */
export function unavailableReason(
	configured: boolean,
	state: ConnectionState,
	endReason: string | null,
) {
	if (!configured) return "browser_not_configured";
	if (state === "connecting") return "browser_connecting";
	if (endReason === "connect_timeout") return "browser_connect_timeout";
	if (endReason === "mcp_unavailable") return "browser_mcp_unavailable";
	if (endReason === "not_configured") return "browser_not_configured";
	return "browser_disconnected";
}

/** What the later single-shot task worker (S2) provides: one step of the model loop per queue job. */
export type TaskStepInput = {
	scriptRequired?: boolean;
	taskId: string;
	owner: string;
	request: string;
	tabRef: string | null;
	url: string | null;
	/** Frozen package/binding references the caller stored at start (opaque to this domain). */
	frozen: unknown;
	/** The serialized task-core state (`TaskState` of the inference domain), null before the first step. */
	coreState: unknown;
	step: number;
	deadline: number;
};
export type TaskStepOutcome =
	| { kind: "continue"; coreState: unknown; delayMs?: number }
	| {
			kind: "done";
			state: "completed" | "needs_input" | "failed";
			coreState: unknown;
			/** Shown to the user and reported into the conversation. */
			text: string;
			errorCode?: string;
			/**
			 * What the user must approve to continue; stored as `pending` when the task ends as `needs_input`
			 * and handed to the follow-up task by `continueFrom`/`approvePending`. Ignored for other end states.
			 */
			approvals?: (ApprovalRequest | InputValueApproval)[];
	  };
/** HTTP status of each code the browser operations throw; `browser_browse_failed` is answered by the route itself. */
export const errorStatus = {
	browser_task_not_found: 404,
	browser_capture_not_found: 404,
	browser_capture_not_ready: 409,
	browser_history_not_found: 404,
	browser_history_conflict: 409,
	browser_executable_invalid: 400,
	browser_browse_busy: 409,
	browser_browse_unsupported: 501,
} as const satisfies Record<string, HttpErrorStatus>;
