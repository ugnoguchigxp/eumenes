import { useState } from "react";
import type { KanbanNoticeView } from "../../../../../api/domains/kanban/contracts";
import type { TimerNotificationDto } from "../../../../../api/domains/timers/contracts";
import { Button, Drawer, NotificationCard } from "../../../design-system";
import "./TimerNotifications.css";

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
	error: string | null;
	onOpenBoard: () => void;
	onRead: (notice: KanbanNoticeView) => void;
};

const KANBAN_TITLES: Record<KanbanNoticeView["kind"], string> = {
	done: "タスクが完了しました",
	blocker: "タスクが止まりました",
	waiting: "タスクが許可を待っています",
	commit_push: "commit & push の報告",
	queue_paused: "実行キューが止まりました",
};

type Entry =
	| { source: "timer"; id: string; at: string; item: TimerNotificationDto }
	| { source: "kanban"; id: string; at: string; item: KanbanNoticeView };

const formatTime = (value: string) =>
	new Intl.DateTimeFormat("ja-JP", {
		month: "numeric",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	}).format(new Date(value));

/** One drawer for every source (timers, Kanban), newest first. */
export function NotificationCenter({
	notices,
	kanban,
	ringingId,
	stoppingIds,
	onStop,
	onPrepareAudio,
	error,
}: {
	notices: TimerNotificationDto[];
	kanban?: KanbanNotifications;
	ringingId: string | null;
	stoppingIds: string[];
	onStop: (item: TimerNotificationDto) => void;
	onPrepareAudio?: () => void;
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
	const sorted = sortEntries([...timerEntries, ...kanbanEntries]);
	// The floating stack carries what still needs a look: timer notices and unread Kanban ones.
	const floating = sorted.filter(
		(entry) => entry.source === "timer" || !entry.item.read,
	);
	const shownError = error ?? kanban?.error ?? null;
	const count = notices.length + (kanban?.unread ?? 0);
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
			: kanbanCard(entry.item);
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
				<div className="notification-center-list" aria-label="通知一覧">
					{audioPrompt}
					{sorted.map((entry) => card(entry))}
					{!sorted.length && (
						<div className="notification-center-empty">
							<NotificationIcon />
							<h3>通知はありません</h3>
							<p>タイマーの終了やタスクの結果が、ここに表示されます。</p>
						</div>
					)}
					{shownError && (
						<p className="notification-error" role="alert">
							{shownError}
						</p>
					)}
				</div>
			</Drawer>
			{!open && (floating.length > 0 || audioPrompt || shownError) && (
				<output
					className="timer-notifications"
					aria-label={
						floating.some((entry) => entry.source === "kanban")
							? "新しい通知"
							: "タイマーの終了"
					}
					aria-live="polite"
					aria-relevant="additions"
				>
					{audioPrompt}
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
					{shownError && (
						<p className="notification-error" role="alert">
							{shownError}
						</p>
					)}
				</output>
			)}
		</>
	);
}
