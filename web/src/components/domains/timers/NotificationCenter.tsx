import { useState } from "react";
/**
 * A task-board notice as the center shows it. Structural, so the timers components do not
 * depend on the kanban domain (the board's hook passes its notices in).
 */
export type KanbanNoticeView = {
	id: string;
	kind:
		| "done"
		| "blocker"
		| "waiting"
		| "commit_push"
		| "queue_paused"
		| "git_completed"
		| "stopped";
	text: string;
	read: boolean;
	createdAt: string;
	cardId?: string;
	runId?: string;
};
/** A finished TODO's notice as the center shows it (structural, like the Kanban notice). */
export type TodoNoticeView = {
	id: string;
	conversationId: string;
	title: string;
	toolchainTitle?: string;
	/** The registered screen of the toolchain the work went to. */
	artifactId?: string;
	outcome: "succeeded" | "partial" | "failed" | "interrupted";
	summary: string | null;
	links: Array<{ uri: string; label: string; kind: string }>;
	read: boolean;
	createdAt: string;
};
import type { TimerNotificationDto } from "../../../../../api/domains/timers/contracts";
import { Button, Drawer, NotificationCard } from "../../../design-system";
import "./TimerNotifications.css";
import { ArtifactIcon, KindIcon } from "../../../domains/resources";
import { useNotificationBanners } from "./useNotificationBanners";

function NotificationIcon({
	clock = false,
	board = false,
}: {
	clock?: boolean;
	board?: boolean;
}) {
	return (
		<svg
			width="20"
			height="20"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.7"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			{board ? (
				<>
					<rect x="3" y="4" width="18" height="16" rx="3" />
					<path d="M9 4v16M15 4v16" />
				</>
			) : clock ? (
				<>
					<circle cx="12" cy="13" r="8" />
					<path d="M12 9v4l2.5 1.5M9 2h6M12 2v3M18.5 6l1.5-1.5" />
				</>
			) : (
				<>
					<rect x="3" y="4" width="18" height="16" rx="4" />
					<path d="M8 9h8M8 13h8M8 17h4" />
				</>
			)}
		</svg>
	);
}

export type KanbanNotifications = {
	notices: KanbanNoticeView[];
	/** Unread across the whole store, not only the listed page. */
	unread: number;
	readingIds: string[];
	/** An action failed (shown wherever notices are). */
	error: string | null;
	/** The list could not be loaded (shown in the drawer only, never over the screen). */
	loadError: string | null;
	onOpenBoard: () => void;
	onRead: (notice: KanbanNoticeView) => void;
};

export type TodoNotifications = {
	notices: TodoNoticeView[];
	/** Unread across the whole ledger, not only the listed page. */
	unread: number;
	/** An action failed (shown wherever notices are). */
	error: string | null;
	/** The list could not be loaded (shown in the drawer only, never over the screen). */
	loadError: string | null;
	/** Opens what the work made (a resource) or the screen of its toolchain, and reads the notice. */
	onOpen: (
		notice: TodoNoticeView,
		target: { uri: string } | { artifactId: string },
	) => void;
	/** Reads the notice: it hides at once. */
	onRead: (notice: TodoNoticeView) => void;
};

/** How a TODO ended when it did not simply succeed, shown before the work. */
const TODO_OUTCOMES: Partial<Record<TodoNoticeView["outcome"], string>> = {
	partial: "一部完了",
	failed: "失敗",
	interrupted: "中断",
};

const KANBAN_TITLES: Record<KanbanNoticeView["kind"], string> = {
	done: "タスクが完了しました",
	blocker: "タスクが止まりました",
	waiting: "タスクが許可を待っています",
	commit_push: "commit & push の報告",
	git_completed: "Git工程を確認しました",
	stopped: "タスクを止めました",
	queue_paused: "実行キューが止まりました",
};

type Entry =
	| { source: "timer"; id: string; at: string; item: TimerNotificationDto }
	| { source: "kanban"; id: string; at: string; item: KanbanNoticeView }
	| { source: "todo"; id: string; at: string; item: TodoNoticeView };

const formatTime = (value: string) =>
	new Intl.DateTimeFormat("ja-JP", {
		month: "numeric",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	}).format(new Date(value));

/**
 * A finished TODO's notice, kept small: the work and its result on a line each, and an icon that launches what can be
 * opened. Pressing it reads it, which hides it from the screen; the drawer keeps it, dimmed.
 */
function TodoNoticeCard({
	item,
	todo,
}: {
	item: TodoNoticeView;
	todo: TodoNotifications;
}) {
	// What can be opened: what the work made, else the screen of its toolchain.
	const opens = item.links.length
		? item.links.slice(0, 3).map((link) => ({
				key: link.uri,
				label: `「${link.label}」を開く`,
				icon: <KindIcon kind={link.kind} />,
				target: { uri: link.uri },
			}))
		: item.artifactId
			? [
					{
						key: item.artifactId,
						label: `${item.toolchainTitle ?? "担当"}の画面を開く`,
						icon: <ArtifactIcon />,
						target: { artifactId: item.artifactId },
					},
				]
			: [];
	const head = item.toolchainTitle
		? `[${item.toolchainTitle}] ${item.title}`
		: item.title;
	const outcome = TODO_OUTCOMES[item.outcome];
	const text = (
		<>
			<span className="todo-notice-head">
				{outcome && <span className="todo-notice-outcome">{outcome}</span>}
				{head}
			</span>
			{item.summary && (
				<span className="todo-notice-summary">{item.summary}</span>
			)}
		</>
	);
	return (
		<article
			className={`todo-notice${item.read ? " todo-notice-read" : ""}`}
			data-outcome={item.outcome}
		>
			{item.read ? (
				<div className="todo-notice-body">{text}</div>
			) : (
				<button
					type="button"
					className="todo-notice-body"
					title="押すと閉じます"
					onClick={() => todo.onRead(item)}
				>
					{text}
				</button>
			)}
			{opens.map((open) => (
				<Button
					key={open.key}
					type="button"
					variant="secondary"
					size="icon"
					className="todo-notice-open"
					aria-label={open.label}
					title={open.label}
					onClick={() => todo.onOpen(item, open.target)}
				>
					{open.icon}
				</Button>
			))}
		</article>
	);
}

/** One drawer for every source (timers, Kanban, finished TODOs), newest first. */
export function NotificationCenter({
	notices,
	kanban,
	todo,
	ringingId,
	stoppingIds,
	onStop,
	onPrepareAudio,
	onClearHistory,
	clearing = false,
	error,
}: {
	notices: TimerNotificationDto[];
	kanban?: KanbanNotifications;
	todo?: TodoNotifications;
	ringingId: string | null;
	stoppingIds: string[];
	onStop: (item: TimerNotificationDto) => void;
	onPrepareAudio?: () => void;
	onClearHistory?: () => void;
	clearing?: boolean;
	error: string | null;
}) {
	const [open, setOpen] = useState(false);
	const sortEntries = (entries: Entry[]) =>
		entries.sort(
			(a, b) => Date.parse(b.at) - Date.parse(a.at) || a.id.localeCompare(b.id),
		);
	const timerEntries = notices.map((item): Entry => ({
		source: "timer",
		id: item.id,
		at: item.dueAt,
		item,
	}));
	const kanbanEntries = (kanban?.notices ?? []).map((item): Entry => ({
		source: "kanban",
		id: item.id,
		at: item.createdAt,
		item,
	}));
	const todoEntries = (todo?.notices ?? []).map((item): Entry => ({
		source: "todo",
		id: item.id,
		at: item.createdAt,
		item,
	}));
	const sorted = sortEntries([
		...timerEntries,
		...kanbanEntries,
		...todoEntries,
	]);
	const pending = sorted.filter(
		(entry) => entry.source === "timer" || !entry.item.read,
	);
	const shownError = error ?? kanban?.error ?? todo?.error ?? null;
	const drawerError =
		shownError ?? kanban?.loadError ?? todo?.loadError ?? null;
	const entryKey = (entry: Entry) => `${entry.source}:${entry.id}`;
	const errorKey = `error:${shownError}`;
	const isBannerVisible = useNotificationBanners([
		...pending.map(entryKey),
		...(onPrepareAudio ? ["audio"] : []),
		...(shownError ? [errorKey] : []),
	]);
	const floating = pending.filter((entry) => isBannerVisible(entryKey(entry)));
	const showAudioBanner = onPrepareAudio && isBannerVisible("audio");
	const showErrorBanner = shownError && isBannerVisible(errorKey);
	const count = notices.length + (kanban?.unread ?? 0) + (todo?.unread ?? 0);
	const audioPrompt = onPrepareAudio && (
		<NotificationCard
			appName="Eumenes"
			title="音でお知らせ"
			message="終了時に音でお知らせするには、通知音を有効にしてください。"
			icon={<NotificationIcon clock />}
			actions={
				<Button variant="secondary" size="sm" onClick={onPrepareAudio}>
					通知音を有効にする
				</Button>
			}
		/>
	);
	// The expiry itself is announced assertively; the drawer list is read on demand.
	const timerCard = (item: TimerNotificationDto, announce = false) => (
		<NotificationCard
			key={`timer:${item.id}`}
			role={announce ? "alert" : undefined}
			className="timer-notification"
			appName="Eumenes"
			title="タイマーが終了しました"
			message={item.message}
			icon={<NotificationIcon clock />}
			timestamp={formatTime(item.dueAt)}
			dateTime={item.dueAt}
			status={
				item.id === ringingId ? (
					<span className="notification-ringing">
						<i aria-hidden="true" />
						通知音を鳴らしています
					</span>
				) : item.status === "silent" ? (
					"通知音なし"
				) : undefined
			}
			actions={
				<Button
					type="button"
					variant="secondary"
					size="sm"
					className="timer-notification-dismiss"
					disabled={stoppingIds.includes(item.id)}
					onClick={() => onStop(item)}
				>
					{stoppingIds.includes(item.id) ? "停止中…" : "通知を停止"}
				</Button>
			}
		/>
	);
	const kanbanCard = (item: KanbanNoticeView) => (
		<NotificationCard
			key={`kanban:${item.id}`}
			className={`kanban-notification${item.read ? " kanban-notification-read" : ""}`}
			appName="タスクボード"
			title={KANBAN_TITLES[item.kind]}
			message={item.text}
			icon={<NotificationIcon board />}
			timestamp={formatTime(item.createdAt)}
			dateTime={item.createdAt}
			status={item.read ? "既読" : undefined}
			actions={
				<>
					<Button
						type="button"
						variant="secondary"
						size="sm"
						className="timer-notification-dismiss"
						onClick={() => kanban?.onOpenBoard()}
					>
						タスクボードを開く
					</Button>
					{!item.read && (
						<Button
							type="button"
							variant="secondary"
							size="sm"
							className="timer-notification-dismiss"
							disabled={kanban?.readingIds.includes(item.id)}
							onClick={() => kanban?.onRead(item)}
						>
							{kanban?.readingIds.includes(item.id) ? "処理中…" : "既読にする"}
						</Button>
					)}
				</>
			}
		/>
	);
	const card = (entry: Entry, announce = false) =>
		entry.source === "timer"
			? timerCard(entry.item, announce)
			: entry.source === "kanban"
				? kanbanCard(entry.item)
				: todo && (
						<TodoNoticeCard
							key={`todo:${entry.id}`}
							item={entry.item}
							todo={todo}
						/>
					);
	return (
		<>
			<Drawer
				isOpen={open}
				onClose={() => setOpen(false)}
				title="通知センター"
				description={
					sorted.length
						? `${sorted.length}件の通知`
						: "届いた通知をここで確認できます。"
				}
				className="notification-center-drawer"
				overlayClassName="notification-center-overlay"
				closeLabel="通知センターを閉じる"
				trigger={
					<Button
						type="button"
						variant="secondary"
						size="icon"
						className="notification-center-trigger"
						aria-label={`通知センター${count ? `、${count}件` : ""}`}
						title="通知センター"
						onClick={() => setOpen(true)}
					>
						<NotificationIcon />
						{count > 0 && (
							<span className="notification-center-badge" aria-hidden="true">
								{count > 99 ? "99+" : count}
							</span>
						)}
					</Button>
				}
			>
				{onClearHistory && (
					<div className="notification-center-toolbar">
						<Button
							type="button"
							variant="secondary"
							size="sm"
							disabled={clearing || (!sorted.length && !count)}
							onClick={onClearHistory}
							title="通知をアーカイブして一覧から消します"
						>
							{clearing ? "クリア中…" : "履歴をクリア"}
						</Button>
					</div>
				)}
				<div className="notification-center-list" aria-label="通知一覧">
					{audioPrompt}
					{sorted.map((entry) => card(entry))}
					{!sorted.length && (
						<div className="notification-center-empty">
							<NotificationIcon />
							<h3>通知はありません</h3>
							<p>
								タイマーの終了や、仕事・タスクの結果が、ここに表示されます。
							</p>
						</div>
					)}
					{drawerError && (
						<p className="notification-error" role="alert">
							{drawerError}
						</p>
					)}
				</div>
			</Drawer>
			{!open && (floating.length > 0 || showAudioBanner || showErrorBanner) && (
				<output
					className="timer-notifications"
					aria-label={
						floating.some((entry) => entry.source !== "timer")
							? "新しい通知"
							: "タイマーの終了"
					}
					aria-live="polite"
					aria-relevant="additions"
				>
					{showAudioBanner && audioPrompt}
					{floating.slice(0, 3).map((entry) => card(entry, true))}
					{floating.length > 3 && (
						<Button
							variant="secondary"
							className="notification-more"
							onClick={() => setOpen(true)}
						>
							ほか{floating.length - 3}件の通知を見る
						</Button>
					)}
					{showErrorBanner && (
						<p className="notification-error" role="alert">
							{shownError}
						</p>
					)}
				</output>
			)}
		</>
	);
}
