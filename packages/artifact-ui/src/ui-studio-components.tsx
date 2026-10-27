import {
	Button,
	ConfirmModal,
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@eumenes/design-system";
import {
	History,
	LayoutTemplate,
	Monitor,
	Play,
	Redo2,
	RefreshCw,
	Save,
	Smartphone,
	Sparkles,
	Square,
	Trash2,
	Undo2,
	CornerUpLeft,
} from "lucide-react";
import { type ReactNode, useId, useMemo, useState } from "react";
import {
	type ArtifactEvent,
	type ArtifactRequest,
	type Snapshot,
	type UiStudioResource,
} from "./contracts";
import { ArtifactRenderer } from "./index";
import { Feedback, useAction } from "./components";
import { type ArtifactRuntime, useArtifactRuntime } from "./runtime";
import {
	hasForm,
	savedFormSource,
	savedPreview,
	trialFormSource,
	trialPreview,
} from "./ui-studio-preview";
import { StudioSource, type StudioWork } from "./ui-studio-source";
import "./ui-studio.css";

type Device = "desktop" | "mobile";
type StudioMode = "preview" | "source";
const trialMessage = "試用です。回答は保存されません。";

/** A small disclosure: a button that reveals a panel; Escape or an outside click closes it. */
function Disclosure({
	label,
	icon,
	children,
}: {
	label: string;
	icon: ReactNode;
	children: (close: () => void) => ReactNode;
}) {
	const [open, setOpen] = useState(false);
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<Button type="button" variant="outline" size="sm">
					{icon}
					{label}
				</Button>
			</PopoverTrigger>
			<PopoverContent
				className="aui-ui-disclosure-panel"
				aria-label={label}
				align="start"
				collisionPadding={8}
			>
				{children(() => setOpen(false))}
			</PopoverContent>
		</Popover>
	);
}

function expiryLabel(expiresAt: string) {
	const date = new Date(expiresAt);
	return Number.isNaN(date.getTime())
		? ""
		: date.toLocaleString("ja-JP", {
				month: "numeric",
				day: "numeric",
				hour: "2-digit",
				minute: "2-digit",
			});
}

/** The draft or a saved work, rendered as a composition (a draft's form is a trial). */
function StudioPreview({
	definition,
	saved,
	device,
}: {
	definition: unknown;
	saved: boolean;
	device: Device;
}) {
	const runtime = useArtifactRuntime();
	const savedForm = runtime.snapshot[savedFormSource];
	const prepared = useMemo(
		() =>
			saved
				? { definition: savedPreview(definition), form: null }
				: trialPreview(definition),
		[definition, saved],
	);
	const snapshot = useMemo<Snapshot>(
		() => ({
			...(prepared.form ? { [trialFormSource]: prepared.form } : {}),
			...(saved && savedForm ? { [savedFormSource]: savedForm } : {}),
		}),
		[prepared.form, saved, savedForm],
	);
	const previewRuntime = useMemo<ArtifactRuntime>(
		() => ({
			...runtime,
			snapshot,
			dispatch: (event) =>
				event.source === trialFormSource
					? Promise.resolve({ status: "accepted", message: trialMessage })
					: runtime.dispatch(event),
		}),
		[runtime, snapshot],
	);
	const text = useMemo(
		() => JSON.stringify(prepared.definition),
		[prepared.definition],
	);
	const waitingForm =
		saved && hasForm(definition) && !savedForm
			? "回答フォームを読み込んでいます"
			: null;
	return (
		<div className={`aui-ui-preview-canvas aui-ui-preview-${device}`}>
			{waitingForm ? (
				<div className="aui-ui-preview-empty">
					<output>{waitingForm}</output>
				</div>
			) : (
				<ArtifactRenderer definition={text} runtime={previewRuntime} />
			)}
		</div>
	);
}

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

function HistoryMenu({
	history,
	hasDraft,
	viewingId,
	send,
	onPick,
}: {
	history: UiStudioResource["history"];
	hasDraft: boolean;
	viewingId: string | undefined;
	send: Send;
	/** Choosing a saved work (the studio asks first when that would drop unsaved work). */
	onPick: (item: UiStudioResource["history"][number]) => void;
}) {
	return (
		<Disclosure
			label="作品履歴"
			icon={<History size={14} aria-hidden="true" />}
		>
			{(close) => (
				<fieldset className="aui-ui-menu" aria-label="保存した作品">
					{hasDraft && (
						<button
							type="button"
							className="aui-ui-menu-item"
							aria-current={!viewingId ? "true" : undefined}
							onClick={() => {
								send("ui-select", { id: "" });
								close();
							}}
						>
							編集中の案
						</button>
					)}
					{history.length ? (
						history.map((item) => (
							<button
								key={item.id}
								type="button"
								className="aui-ui-menu-item"
								aria-current={viewingId === item.id ? "true" : undefined}
								onClick={() => {
									onPick(item);
									close();
								}}
							>
								{item.title || "名称未設定"}
							</button>
						))
					) : (
						<p className="aui-ui-menu-empty">保存した作品はまだありません。</p>
					)}
				</fieldset>
			)}
		</Disclosure>
	);
}

/** Progress of a running turn, and the unsaved/suspended/viewing notices. */
function StudioNotices({
	data,
	pending,
	send,
}: {
	data: UiStudioResource;
	pending: boolean;
	send: Send;
}) {
	const { work, viewing, session } = data;
	const suspended = session?.state === "suspended";
	const expiry = session ? expiryLabel(session.expiresAt) : "";
	return (
		<>
			{work?.busy && (
				<div className="aui-ui-progress">
					<output aria-live="polite">
						<Sparkles size={14} aria-hidden="true" />{" "}
						制作しています。完成すると反映されます。
					</output>
					{data.stoppable && (
						<Button
							type="button"
							variant="outline"
							size="sm"
							disabled={pending}
							onClick={() => send("ui-stop")}
						>
							<Square size={14} aria-hidden="true" />
							停止
						</Button>
					)}
				</div>
			)}
			{work?.dirty && (
				<p
					className="aui-ui-notice"
					data-state={suspended ? "suspended" : undefined}
				>
					{suspended && (
						<strong>未保存・一時保留{expiry ? `（${expiry}まで）` : ""}</strong>
					)}
					<span>
						保存ボタンを押すまで作品には保存されません。サーバーの再起動や期限切れで破棄されます。
					</span>
					{suspended && (
						<Button
							type="button"
							size="sm"
							disabled={pending}
							onClick={() => send("ui-resume")}
						>
							<Play size={14} aria-hidden="true" />
							編集を再開
						</Button>
					)}
				</p>
			)}
			{viewing && (
				<p className="aui-ui-notice">
					<span>
						{work
							? "保存した作品を表示しています。編集中の案は残っています。"
							: "保存した作品を表示しています。"}
					</span>
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={() => send("ui-select", { id: "" })}
					>
						{work ? "編集中の案に戻る" : "新規作成"}
					</Button>
				</p>
			)}
		</>
	);
}

/** The main area: the draft or the viewed saved work as a preview, or as its OpenUI source. */
function StudioMain({
	heading,
	shown,
	work,
	viewing,
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
	const rejectedOnly = empty && mode === "source" && !!work?.rejected;
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
								definition={shown.definition}
								saved={viewing}
								device={device}
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
	const { work, viewing, history, session } = data;
	const heading = useId();
	const [deleting, setDeleting] = useState(false);
	const [switching, setSwitching] = useState<{
		id: string;
		title: string;
	} | null>(null);
	const suspended = session?.state === "suspended";
	const busy = !!work?.busy;
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
							data-state={suspended ? "suspended" : undefined}
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
						hasDraft={!!work}
						viewingId={viewing?.id}
						send={send}
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
					{/* A viewed saved work is not edited here: deleting it is its only action. */}
					{viewing ? (
						<Button
							type="button"
							variant="outline-destructive"
							size="sm"
							disabled={action.pending}
							onClick={() => setDeleting(true)}
						>
							<Trash2 size={14} aria-hidden="true" />
							削除
						</Button>
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
								disabled={!editing || busy || !work?.dirty || action.pending}
								onClick={() =>
									work &&
									send("ui-save", {
										workRef: work.workRef,
										expectedRevision: String(work.revision),
										expectedSavedRevision: String(work.savedRevision ?? 0),
									})
								}
							>
								<Save size={14} aria-hidden="true" />
								保存
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
			<StudioNotices data={data} pending={action.pending} send={send} />
			<StudioMain
				heading={heading}
				shown={shown}
				work={viewing ? null : work}
				viewing={!!viewing}
				editing={editing}
				device={device}
				onDevice={onDevice}
				mode={mode}
				onMode={onMode}
				onRefresh={() => send("ui-refresh")}
				pending={action.pending}
				busy={busy}
				result={{ status: action.status, message: action.message }}
				onApply={applySource}
			/>
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
			{viewing && (
				<ConfirmModal
					open={deleting}
					onOpenChange={setDeleting}
					title="作品を削除しますか"
					description={`「${viewing.title || "名称未設定"}」を作品履歴から削除します。元に戻せません。`}
					confirmText="削除する"
					cancelText="やめる"
					variant="destructive"
					onConfirm={() => {
						setDeleting(false);
						send("ui-delete", {
							projectId: viewing.id,
							expectedSavedRevision: String(viewing.savedRevision),
						});
					}}
					onCancel={() => setDeleting(false)}
				/>
			)}
		</div>
	);
}
