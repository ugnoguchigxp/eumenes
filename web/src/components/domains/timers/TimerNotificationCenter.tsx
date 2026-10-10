import { useState } from "react";
import type { TimerNotificationDto } from "../../../../../api/domains/timers/contracts";
import { Button, Drawer, NotificationCard } from "../../../design-system";
import "./TimerNotifications.css";

function NotificationIcon({ clock = false }: { clock?: boolean }) {
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
			{clock ? (
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

export function TimerNotificationCenter({
	notices,
	ringingId,
	stoppingIds,
	onStop,
	onPrepareAudio,
	error,
}: {
	notices: TimerNotificationDto[];
	ringingId: string | null;
	stoppingIds: string[];
	onStop: (item: TimerNotificationDto) => void;
	onPrepareAudio?: () => void;
	error: string | null;
}) {
	const [open, setOpen] = useState(false);
	const sorted = [...notices].sort(
		(a, b) =>
			Date.parse(b.dueAt) - Date.parse(a.dueAt) || a.id.localeCompare(b.id),
	);
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
	const card = (item: TimerNotificationDto, announce = false) => (
		<NotificationCard
			key={item.id}
			role={announce ? "alert" : undefined}
			className="timer-notification"
			appName="Eumenes"
			title="タイマーが終了しました"
			message={item.message}
			icon={<NotificationIcon clock />}
			timestamp={new Intl.DateTimeFormat("ja-JP", {
				month: "numeric",
				day: "numeric",
				hour: "2-digit",
				minute: "2-digit",
			}).format(new Date(item.dueAt))}
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
	return (
		<>
			<Drawer
				isOpen={open}
				onClose={() => setOpen(false)}
				title="通知センター"
				description={
					notices.length
						? `${notices.length}件の通知`
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
						aria-label={`通知センター${notices.length ? `、${notices.length}件` : ""}`}
						title="通知センター"
						onClick={() => setOpen(true)}
					>
						<NotificationIcon />
						{notices.length > 0 && (
							<span className="notification-center-badge" aria-hidden="true">
								{notices.length > 99 ? "99+" : notices.length}
							</span>
						)}
					</Button>
				}
			>
				<div className="notification-center-list" aria-label="通知一覧">
					{audioPrompt}
					{sorted.map((item) => card(item))}
					{!notices.length && (
						<div className="notification-center-empty">
							<NotificationIcon />
							<h3>通知はありません</h3>
							<p>タイマーが終了すると、ここに表示されます。</p>
						</div>
					)}
					{error && (
						<p className="notification-error" role="alert">
							{error}
						</p>
					)}
				</div>
			</Drawer>
			{!open && (notices.length > 0 || audioPrompt || error) && (
				<output
					className="timer-notifications"
					aria-label="タイマーの終了"
					aria-live="polite"
					aria-relevant="additions"
				>
					{audioPrompt}
					{sorted.slice(0, 3).map((item) => card(item, true))}
					{notices.length > 3 && (
						<Button
							variant="secondary"
							className="notification-more"
							onClick={() => setOpen(true)}
						>
							ほか{notices.length - 3}件の通知を見る
						</Button>
					)}
					{error && (
						<p className="notification-error" role="alert">
							{error}
						</p>
					)}
				</output>
			)}
		</>
	);
}
