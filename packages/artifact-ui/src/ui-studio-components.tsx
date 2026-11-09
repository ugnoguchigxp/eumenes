import { Button, ConfirmModal } from "@eumenes/design-system";
import {
	CornerUpLeft,
	LayoutTemplate,
	Monitor,
	Redo2,
	RefreshCw,
	Save,
	Smartphone,
	Trash2,
	Undo2,
} from "lucide-react";
import { useId, useState } from "react";
import { Feedback, useAction } from "./action";
import {
	type ArtifactEvent,
	type ArtifactRequest,
	type UiStudioResource,
} from "./contracts";
import { hasForm } from "./ui-studio-preview";
import { StudioPreview } from "./ui-studio-render-preview";
import { StudioSource, type StudioWork } from "./ui-studio-source";
import { HistoryMenu, StudioNotices } from "./ui-studio-status";
import "./ui-studio.css";

type Device = "desktop" | "mobile";
type StudioMode = "preview" | "source";
type AppViewing = NonNullable<UiStudioResource["viewing"]>;

export function UiStudioView({ request }: { request: ArtifactRequest }) {
	const action = useAction(request);
	// Display state only: switching never regenerates, saves or touches the undo history.
	const [device, setDevice] = useState<Device>("desktop");
	const [view, setView] = useState<StudioMode>("preview");
	const data = action.resource;
	if (request.view !== "ui-studio" || data?.kind !== "ui-studio") return null;
	return (
		<Studio
			data={data}
			title={request.title}
			action={action}
			device={device}
			onDevice={setDevice}
			mode={view}
			onMode={setView}
		/>
	);
}

type Send = (
	event: ArtifactEvent["action"],
	values?: ArtifactEvent["values"],
) => void;

/** The main area: the draft or the viewed saved work as a preview, or as its OpenUI source. */
function StudioMain({
	heading,
	shown,
	work,
	viewing,
	app,
	editing,
	device,
	onDevice,
	mode,
	onMode,
	onRefresh,
	pending,
	busy,
	result,
	onApply,
}: {
	heading: string;
	shown: {
		definition: unknown;
		/** The source text shown; a saved work has no earlier revision to compare. */
		text: string;
		previousText: string | null;
		revision: number;
	} | null;
	/** The draft the source can be edited into; null while a saved work is viewed. */
	work: StudioWork | null;
	viewing: boolean;
	app?: AppViewing;
	editing: boolean;
	device: Device;
	onDevice: (device: Device) => void;
	mode: StudioMode;
	onMode: (mode: StudioMode) => void;
	onRefresh: () => void;
	pending: boolean;
	/** A specialist turn holds the work (the first draft may be on its way). */
	busy: boolean;
	/** The last receipt: a refused source apply is shown beside the editor. */
	result: { status: string; message: string };
	onApply: (text: string, revision: number) => Promise<boolean>;
}) {
	// Nothing to show yet: no work, or a work whose first draft was never accepted.
	const empty = !shown || shown.definition == null;
	// A first draft that failed the check has no preview, but its text is still worth fixing.
	const rejectedOnly =
		empty && mode === "source" && (!!work?.rejected || !!shown?.text);
	// Both stay mounted: switching is display state and keeps trial input.
	return (
		<section className="aui-ui-preview-panel" aria-labelledby={heading}>
			<div className="aui-ui-panel-head">
				<div className="aui-ui-panel-controls">
					<fieldset className="aui-ui-view-toggle" aria-label="表示の切替">
						{(["preview", "source"] as const).map((value) => (
							<button
								key={value}
								type="button"
								aria-pressed={mode === value}
								onClick={() => onMode(value)}
							>
								{value === "preview" ? "プレビュー" : "ソース"}
							</button>
						))}
					</fieldset>
					<Button
						type="button"
						variant="ghost"
						size="sm"
						className="aui-ui-refresh"
						aria-label="表示を更新"
						title="表示を更新"
						disabled={pending}
						onClick={onRefresh}
					>
						<RefreshCw size={16} aria-hidden="true" />
					</Button>
				</div>
				{mode === "preview" && (
					<div className="aui-ui-device">
						<button
							type="button"
							aria-pressed={device === "desktop"}
							onClick={() => onDevice("desktop")}
						>
							<Monitor size={16} aria-hidden="true" /> デスクトップ
						</button>
						<button
							type="button"
							aria-pressed={device === "mobile"}
							onClick={() => onDevice("mobile")}
						>
							<Smartphone size={16} aria-hidden="true" /> モバイル
						</button>
					</div>
				)}
			</div>
			{shown && (!empty || rejectedOnly) ? (
				<>
					{!empty && (
						<div className="aui-ui-preview-stage" hidden={mode !== "preview"}>
							<StudioPreview
								key={app?.id}
								definition={shown.definition}
								saved={viewing && !app}
								device={device}
								app={app}
							/>
						</div>
					)}
					{mode === "source" && (
						<StudioSource
							text={shown.text}
							previousText={shown.previousText}
							label={viewing ? "保存済み" : "編集中"}
							revision={shown.revision}
							work={work}
							pending={pending}
							result={result}
							onApply={onApply}
						/>
					)}
				</>
			) : (
				<div className="aui-ui-preview-stage">
					<div className="aui-ui-preview-canvas aui-ui-preview-empty">
						<LayoutTemplate aria-hidden="true" />
						<strong>
							{busy
								? "初稿を作成しています"
								: mode === "source"
									? "まだ定義がありません"
									: "ここに作品を表示します"}
						</strong>
						<span>
							{busy
								? "反映されるとプレビューとソースに表示します。"
								: mode === "source"
									? "初稿が反映されると、ここにOpenUI定義のJSONを表示します。"
									: "会話で作りたいUIを伝えてください。保存した作品は作品履歴から選べます。"}
						</span>
					</div>
				</div>
			)}
			{editing && mode === "preview" && hasForm(shown?.definition) && (
				<p className="aui-ui-trial">
					フォームは試用です。送信しても回答は保存されません。
				</p>
			)}
		</section>
	);
}

function Studio({
	data,
	title,
	action,
	device,
	onDevice,
	mode,
	onMode,
}: {
	data: UiStudioResource;
	title: string | undefined;
	action: ReturnType<typeof useAction>;
	device: Device;
	onDevice: (device: Device) => void;
	mode: StudioMode;
	onMode: (mode: StudioMode) => void;
}) {
	const { work, viewing, history, session, appDevelopment } = data;
	const heading = useId();
	const [deleting, setDeleting] = useState(false);
	const [switching, setSwitching] = useState<{
		id: string;
		title: string;
	} | null>(null);
	const suspended = session?.state === "suspended";
	const busy = !!work?.busy;
	const storagePending =
		work?.storageState === "initializing" || work?.storageState === "deleting";
	const deletingApp = viewing?.storageState === "deleting";
	// The draft is what the controls act on; a viewed saved work hides it from the preview.
	const editing = !!work && !viewing;
	const shown = viewing
		? {
				definition: viewing.definition,
				text:
					JSON.stringify(
						viewing.storedDefinition ?? viewing.definition,
						null,
						2,
					) ?? "null",
				previousText: null,
				revision: viewing.savedRevision,
			}
		: work
			? {
					definition: work.definition,
					text: work.source,
					previousText: work.previousSource,
					revision: work.revision,
				}
			: null;
	const send: Send = (event, values = {}) => void action.send(event, values);
	const step = (event: "ui-undo" | "ui-redo") =>
		work &&
		send(event, {
			workRef: work.workRef,
			expectedRevision: String(work.revision),
		});
	const applySource = (text: string, revision: number) =>
		work && !viewing
			? action.send("ui-source-apply", {
					workRef: work.workRef,
					expectedRevision: String(revision),
					text,
				})
			: Promise.resolve(false);
	const state = viewing
		? "保存済み"
		: suspended
			? "未保存・一時保留"
			: work?.dirty
				? "編集中・未保存"
				: work
					? "編集中"
					: "";
	const draftAction = !work
		? "新規作成"
		: work.dirty || work.rejected || busy
			? "編集中の案に戻る"
			: "編集に戻る";
	return (
		<div className="aui-ui-studio" data-busy={busy ? "true" : undefined}>
			<header className="aui-ui-studio-bar">
				<div className="aui-ui-studio-title">
					<h2 id={heading}>
						{viewing?.title || work?.title || title || "UI自由制作"}
					</h2>
					{state && (
						<span
							className="aui-ui-state"
							data-state={editing && suspended ? "suspended" : undefined}
						>
							{state}
						</span>
					)}
				</div>
				<div
					className="aui-ui-studio-actions"
					role="toolbar"
					aria-label="UI制作の操作"
				>
					<HistoryMenu
						history={history}
						viewingId={viewing?.id}
						onPick={(item) => {
							// The active specialist would edit the chosen work instead: unsaved work is not dropped silently.
							if (
								session?.state === "active" &&
								work?.dirty &&
								!busy &&
								work.savedRef !== item.id
							)
								setSwitching(item);
							else send("ui-select", { id: item.id });
						}}
					/>
					{viewing ? (
						<>
							<Button
								type="button"
								variant="outline"
								size="sm"
								disabled={action.pending}
								onClick={() => send("ui-select", { id: "" })}
							>
								{draftAction}
							</Button>
							{(!appDevelopment || viewing.deleteDigest) && (
								<Button
									type="button"
									variant="outline-destructive"
									size="sm"
									disabled={
										action.pending ||
										(deletingApp && !viewing.storageError) ||
										viewing.storageState === "initializing"
									}
									onClick={() => setDeleting(true)}
								>
									<Trash2 size={14} aria-hidden="true" />
									{appDevelopment
										? deletingApp
											? "削除を再試行"
											: "アプリを削除"
										: "削除"}
								</Button>
							)}
						</>
					) : (
						<>
							<Button
								type="button"
								variant="outline"
								size="sm"
								disabled={!editing || busy || !work?.canUndo || action.pending}
								onClick={() => step("ui-undo")}
							>
								<Undo2 size={14} aria-hidden="true" />
								元に戻す
							</Button>
							<Button
								type="button"
								variant="outline"
								size="sm"
								disabled={!editing || busy || !work?.canRedo || action.pending}
								onClick={() => step("ui-redo")}
							>
								<Redo2 size={14} aria-hidden="true" />
								やり直す
							</Button>
							<Button
								type="button"
								size="sm"
								disabled={
									!editing ||
									busy ||
									!work?.dirty ||
									storagePending ||
									action.pending ||
									(appDevelopment && !work.confirmation)
								}
								onClick={() =>
									work &&
									send("ui-save", {
										workRef: work.workRef,
										expectedRevision: String(work.revision),
										expectedSavedRevision: String(work.savedRevision ?? 0),
										...(work.confirmation
											? { digest: work.confirmation.digest }
											: {}),
									})
								}
							>
								<Save size={14} aria-hidden="true" />
								{appDevelopment ? "確認して保存" : "保存"}
							</Button>
							<Button
								type="button"
								variant="outline-destructive"
								size="sm"
								disabled={!work || action.pending}
								onClick={() => send("ui-discard")}
							>
								<Trash2 size={14} aria-hidden="true" />
								破棄
							</Button>
						</>
					)}
					{session?.state === "active" && (
						<Button
							type="button"
							variant="outline"
							size="sm"
							disabled={action.pending}
							onClick={() => send("ui-return")}
						>
							<CornerUpLeft size={14} aria-hidden="true" />
							会話に戻る
						</Button>
					)}
				</div>
			</header>
			{editing && (
				<StudioNotices data={data} pending={action.pending} send={send} />
			)}
			{appDevelopment && (
				<StorageProgress
					viewing={viewing}
					work={work}
					pending={storagePending}
				/>
			)}

			{appDevelopment && editing && work?.issue && (
				<Feedback message={`確認が必要です（${work.issue}）。`} />
			)}
			{appDevelopment && editing && work?.confirmation?.summary != null && (
				<AppConfirmation summary={work.confirmation.summary} />
			)}
			{appDevelopment && viewing?.workflow && (
				<AppWorkflowPanel
					key={viewing.id}
					viewing={viewing}
					pending={action.pending}
					send={send}
				/>
			)}
			{!deletingApp && viewing?.storageState !== "initializing" && (
				<StudioMain
					heading={heading}
					shown={shown}
					work={viewing ? null : work}
					viewing={!!viewing}
					app={appDevelopment ? (viewing ?? undefined) : undefined}
					editing={editing}
					device={device}
					onDevice={onDevice}
					mode={mode}
					onMode={onMode}
					onRefresh={() => send("ui-refresh")}
					pending={action.pending}
					busy={editing && busy}
					result={{ status: action.status, message: action.message }}
					onApply={applySource}
				/>
			)}
			<Feedback message={action.message} />
			<ConfirmModal
				open={!!switching}
				onOpenChange={(open) => {
					if (!open) setSwitching(null);
				}}
				title="未保存の案があります"
				description={`保存していない案を破棄して、「${switching?.title || "名称未設定"}」の編集に切り替えます。`}
				confirmText="破棄して切り替える"
				cancelText="編集を続ける"
				variant="destructive"
				onConfirm={() => {
					if (switching) send("ui-retarget", { id: switching.id });
					setSwitching(null);
				}}
				onCancel={() => setSwitching(null)}
			/>
			{viewing && (!appDevelopment || viewing.deleteDigest) && (
				<AppDeletion
					viewing={viewing}
					appDevelopment={appDevelopment}
					deleting={deleting}
					onOpenChange={setDeleting}
					send={send}
				/>
			)}
		</div>
	);
}

function StorageProgress({
	viewing,
	work,
	pending,
}: Pick<UiStudioResource, "viewing" | "work"> & { pending: boolean }) {
	if (!viewing && pending)
		return (
			<output className="aui-ui-notice">
				{work?.storageError
					? `保存先を準備できませんでした（${work.storageError}）。`
					: "アプリの保存先を準備しています。"}
			</output>
		);
	if (
		viewing?.storageState !== "deleting" &&
		viewing?.storageState !== "initializing"
	)
		return null;
	return (
		<output className="aui-ui-notice">
			{viewing.storageState === "deleting"
				? "アプリの削除待ち"
				: "アプリの保存先を準備しています。"}
			{viewing.storageError ? `（${viewing.storageError}）` : ""}
		</output>
	);
}

function AppDeletion({
	viewing,
	appDevelopment,
	deleting,
	onOpenChange,
	send,
}: {
	viewing: AppViewing;
	appDevelopment?: boolean;
	deleting: boolean;
	onOpenChange(open: boolean): void;
	send: Send;
}) {
	return (
		<ConfirmModal
			open={deleting}
			onOpenChange={onOpenChange}
			title={appDevelopment ? "アプリを削除しますか" : "作品を削除しますか"}
			description={`「${viewing.title || "名称未設定"}」を作品履歴から削除します。${viewing.hasStorage ? "このアプリに保存した記録も削除されます。" : ""}元に戻せません。`}
			confirmText="削除する"
			cancelText="やめる"
			variant="destructive"
			onConfirm={() => {
				onOpenChange(false);
				if (appDevelopment && viewing.deleteDigest) {
					send("ui-app-delete", {
						appId: viewing.id,
						revision: String(viewing.savedRevision),
						digest: viewing.deleteDigest,
					});
				} else {
					send("ui-delete", {
						projectId: viewing.id,
						expectedSavedRevision: String(viewing.savedRevision),
					});
				}
			}}
			onCancel={() => onOpenChange(false)}
		/>
	);
}

function AppConfirmation({ summary }: { summary: unknown }) {
	const data = summary as {
		trigger?: string;
		storage?: Array<{
			id: string;
			operations: string[];
			columns: Array<{ name: string; type: string }>;
		}>;
		input?: { fixed?: Record<string, unknown> };
		publish?: { destinationRef?: string };
		pipeline?: { steps?: Array<{ bundle: string; task: string }> };
	};
	return (
		<details open className="aui-ui-notice">
			<summary>実行内容を確認</summary>
			{data.trigger && (
				<p>起動 {data.trigger === "schedule" ? "予約" : "手動"}</p>
			)}
			{data.storage && (
				<div>
					<p>
						このアプリに記録を保存します。アプリを削除すると記録も削除されます。
					</p>
					<ul>
						{data.storage.map(({ id, operations, columns }) => (
							<li key={id}>
								{id}　
								{columns
									.map(({ name, type }) => `${name}（${type}）`)
									.join("、")}
								　{operations.join("、")}
							</li>
						))}
					</ul>
				</div>
			)}
			{data.input?.fixed && Object.keys(data.input.fixed).length > 0 && (
				<p>
					固定入力{" "}
					{Object.entries(data.input.fixed)
						.map(([key, value]) => `${key}＝${String(value)}`)
						.join("、")}
				</p>
			)}
			{data.publish?.destinationRef && (
				<p>保存先 {data.publish.destinationRef}</p>
			)}
			{data.pipeline?.steps && (
				<ol>
					{data.pipeline.steps.map((step, index) => (
						<li key={index}>{step.task}</li>
					))}
				</ol>
			)}
		</details>
	);
}

function AppWorkflowPanel({
	viewing,
	pending,
	send,
}: {
	viewing: AppViewing;
	pending: boolean;
	send: Send;
}) {
	const [anchor, setAnchor] = useState("");
	const status = viewing.status;
	const state = status?.state === "completed" ? undefined : status?.state;
	const busy = ["accepted", "running", "publishing"].includes(state ?? "");
	const canRunDirectly = !Object.keys(viewing.bindings?.inputs ?? {}).length;
	const scheduled = viewing.workflow?.trigger === "schedule";
	const partial =
		(viewing.data as { coverage?: string } | null)?.coverage === "partial";
	if (
		!state &&
		!status?.result?.code &&
		!status?.result?.path &&
		!partial &&
		!canRunDirectly &&
		!scheduled
	)
		return null;
	const base = { appId: viewing.id, revision: String(viewing.savedRevision) };
	const states: Record<string, string> = {
		accepted: "受付済み",
		running: "実行中",
		publishing: "保存を確認中",
		failed: "失敗",
		cancelled: "取消済み",
		expired: "期限切れ",
	};
	return (
		<section className="aui-ui-notice" aria-label="アプリの実行状況">
			{state && <output aria-live="polite">{states[state] ?? state}</output>}
			{status?.result?.code && <p>{status.result.code}</p>}
			{status?.result?.code === "workflow_markdown_needs_confirmation" &&
				status.runId && (
					<Button
						size="sm"
						variant="outline"
						disabled={pending}
						onClick={() =>
							send("ui-workflow-reconcile", { ...base, runId: status.runId! })
						}
					>
						保存を再確認する
					</Button>
				)}
			{status?.result?.path && <p>保存先 {status.result.path}</p>}
			{partial && <p>確認できた範囲のみ表示しています。</p>}
			{canRunDirectly && (
				<Button
					size="sm"
					disabled={pending || busy}
					onClick={() => send("ui-workflow-run", { ...base, values: "{}" })}
				>
					今すぐ実行
				</Button>
			)}
			{busy && status?.runId && (
				<Button
					size="sm"
					variant="outline"
					disabled={pending}
					onClick={() =>
						send("ui-workflow-cancel", { ...base, runId: status.runId! })
					}
				>
					実行を取り消す
				</Button>
			)}
			{scheduled && (
				<div>
					<label>
						初回の日時（日本時間）{" "}
						<input
							type="datetime-local"
							value={anchor}
							onChange={(event) => setAnchor(event.currentTarget.value)}
						/>
					</label>
					<Button
						size="sm"
						disabled={pending || !anchor}
						onClick={() =>
							send("ui-workflow-schedule", {
								...base,
								anchor: `${anchor}:00+09:00`,
							})
						}
					>
						毎日の予約を有効にする
					</Button>
					{status?.schedule?.state === "active" && (
						<Button
							size="sm"
							variant="outline"
							disabled={pending}
							onClick={() => send("ui-workflow-stop", base)}
						>
							予約を停止する
						</Button>
					)}
					{status?.schedule?.nextDueAt && (
						<p>
							次回{" "}
							{new Date(status.schedule.nextDueAt).toLocaleString("ja-JP", {
								timeZone: "Asia/Tokyo",
							})}
						</p>
					)}
				</div>
			)}
		</section>
	);
}
