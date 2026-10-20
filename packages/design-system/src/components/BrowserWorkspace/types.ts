/** 取得不能の理由コード。未知のコードは汎用文言で表示する。 */
export type BrowserUnavailableReason =
	| "browser_not_configured"
	| "browser_disconnected"
	| "browser_connect_timeout"
	| "browser_mcp_unavailable"
	| (string & {});

/** Braveとの接続状態。利用者が接続するまでは disconnected。 */
export type BrowserConnectionState =
	| "disconnected"
	| "connecting"
	| "connected";

/** 接続が終わった理由。未知のコードは汎用文言で表示する。 */
export type BrowserConnectionEndReason =
	| "user_disconnected"
	| "browser_closed"
	| "process_exited"
	| "backend_stopped"
	| "connect_timeout"
	| (string & {});

export type BrowserConnection = {
	state: BrowserConnectionState;
	/** 直前の接続が終わった理由。disconnected のときだけ表示する。 */
	endReason?: BrowserConnectionEndReason;
};

export type BrowserAvailability =
	| { available: true }
	| { available: false; reason: BrowserUnavailableReason };

/** blocked: 安全のためホストが操作を止めたタブ（切り替え・操作・撮影ができない）。 */
export type BrowserTabStatus = "open" | "busy" | "lost" | "closed" | "blocked";

export type BrowserTabItem = {
	tabRef: string;
	title: string;
	url: string;
	/** 現在の操作対象として選ばれているタブ。 */
	active: boolean;
	status: BrowserTabStatus;
	/** 実行中の作業の短い説明。 */
	currentTaskLabel?: string;
};

export type BrowserTaskState =
	| "queued"
	| "running"
	| "completed"
	| "needs_input"
	| "failed"
	| "cancelled"
	| "expired"
	| "indeterminate";

export type BrowserScriptRevision = {
	revision: number;
	summary: string;
	change?: string;
	updatedAt: number;
	steps: {
		stepId: string;
		label: string;
		expectation: string;
		state: "pending" | "running" | "completed" | "skipped";
		evidenceRef?: string;
	}[];
};
export type BrowserTaskItem = {
	phase?:
		| "preparing"
		| "thinking"
		| "connecting"
		| "observing"
		| "operating"
		| "capturing"
		| null;
	operations?: {
		operationId: string;
		sequence: number;
		scriptRevision: number | null;
		stepId: string | null;
		toolKind: string;
		state: "prepared" | "dispatched" | "observed" | "failed" | "indeterminate";
		observedAt: number;
		observationRef: string | null;
		errorLabel: string | null;
	}[];
	conversationId?: string;
	continuedFrom?: string | null;
	errorLabel?: string;
	script?:
		| (BrowserScriptRevision & { history: BrowserScriptRevision[] })
		| null;
	taskId: string;
	/** 元の依頼の要約。 */
	requestSummary: string;
	state: BrowserTaskState;
	/** 完了時の短い結果、または止まった地点。 */
	resultSummary?: string;
};

export type BrowserCaptureRange = "viewport" | "full-page" | "element";

export type BrowserCaptureState =
	| "queued"
	| "capturing"
	| "encoding"
	| "local_ready"
	| "failed"
	| "cancelled"
	| "expired";

export type BrowserCaptureItem = {
	captureId: string;
	range: BrowserCaptureRange;
	/** ISO 8601。 */
	capturedAt: string;
	width: number;
	height: number;
	bytes: number;
	/** 元PNGに対する容量の削減率（0〜100）。 */
	reductionPercent: number;
	state: BrowserCaptureState;
	errorLabel?: string;
};

export type BrowserPickedPath = { path: string; pickId: number };

export type BrowserWorkspaceProps = {
	onOpenSettings?: () => void;
	title?: string;
	availability: BrowserAvailability;
	connection: BrowserConnection;
	/** 保存済みのBraveの実行ファイルのパス。未設定なら空または省略。 */
	executablePath?: string;
	/** 未設定のとき、標準の場所で見つかったBraveのパス。保存するまでは使わない。 */
	suggestedExecutablePath?: string;
	/** OSのファイル選択で選んだ、まだ保存していないパス。選ぶたびに pickId が変わり、入力欄に入る。 */
	pickedExecutable?: BrowserPickedPath;
	/** OSのファイル選択を開けるとき true。「参照…」を出す。 */
	canBrowseExecutable?: boolean;
	tabs: readonly BrowserTabItem[];
	tasks: readonly BrowserTaskItem[];
	captures: readonly BrowserCaptureItem[];
	selectedCaptureId?: string;
	/** 選択中のcaptureのプレビュー画像URL。ホストが渡す。 */
	previewSrc?: string;
	pending?: boolean;
	loading?: boolean;
	error?: string;
	message?: string;
	/** Braveへの接続を始める。 */
	onConnect: () => void;
	onDisconnect: () => void;
	/** Braveの実行ファイルのパスを保存する。 */
	onSaveExecutablePath: (path: string) => void;
	/** OSのファイル選択を開く。選んだパスは pickedExecutable で戻る。 */
	onBrowseExecutablePath?: () => void;
	/** 新しくURLを開く。 */
	onOpenUrl: (url: string) => void;
	/** 既存のタブへ切り替える。 */
	onFocusTab: (tabRef: string) => void;
	onCloseTab: (tabRef: string) => void;
	onSelectCapture: (captureId: string) => void;
	onDownloadCapture: (captureId: string) => void;
	onCancelTask: (taskId: string) => void;
	onCancelCapture: (captureId: string) => void;
};
