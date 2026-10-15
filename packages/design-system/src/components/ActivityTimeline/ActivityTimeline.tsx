import { useId, useLayoutEffect, useRef, useState } from "react";
import { Button } from "../Button";
import { cn } from "@/utils/cn";
import "./ActivityTimeline.css";

export type ActivityEntry = {
	id: string;
	at: string;
	title: string;
	detail?: string;
	status?: "working" | "completed" | "failed" | "unknown";
	truncated?: boolean;
};
export type ActivityTimelineProps = {
	title?: string;
	entries: readonly ActivityEntry[];
	connected?: boolean;
	emptyText?: string;
	disconnectedText?: string;
	hasEarlier?: boolean;
	loadingEarlier?: boolean;
	onLoadEarlier?: () => void;
	className?: string;
};
const statusLabels = {
	working: "進行中",
	completed: "終了",
	failed: "失敗",
	unknown: "未確認",
};
const time = (value: string) => {
	const parsed = new Date(value);
	return Number.isNaN(parsed.getTime())
		? "時刻未取得"
		: parsed.toLocaleTimeString("ja-JP", {
				hour: "2-digit",
				minute: "2-digit",
				second: "2-digit",
			});
};

/** Controlled activity data. No API, provider, task state or percentage inference lives here. */
export function ActivityTimeline({
	title = "作業の動き",
	entries,
	connected = true,
	emptyText = "まだ動きの記録はありません",
	disconnectedText = "接続を確認してください。保存済みの記録を表示しています",
	hasEarlier,
	loadingEarlier,
	onLoadEarlier,
	className,
}: ActivityTimelineProps) {
	const heading = useId();
	const container = useRef<HTMLDivElement>(null);
	const [following, setFollowing] = useState(true);
	const last = entries.at(-1)?.id;
	useLayoutEffect(() => {
		if (following && container.current)
			container.current.scrollTop = container.current.scrollHeight;
	}, [following, last]);
	return (
		<section
			className={cn("activity-timeline", className)}
			aria-labelledby={heading}
		>
			<header>
				<h3 id={heading}>{title}</h3>
				<label>
					<input
						type="checkbox"
						checked={following}
						onChange={(event) => setFollowing(event.target.checked)}
					/>
					新しい動きを追う
				</label>
				{!following && (
					<Button
						type="button"
						size="sm"
						variant="outline"
						onClick={() => setFollowing(true)}
					>
						最新へ
					</Button>
				)}
			</header>
			{!connected && <p role="status">{disconnectedText}</p>}
			<div
				ref={container}
				className="activity-timeline-scroll"
				tabIndex={0}
				aria-label="動きの記録"
				onScroll={(event) => {
					const node = event.currentTarget;
					if (node.scrollHeight - node.clientHeight - node.scrollTop > 32)
						setFollowing(false);
				}}
			>
				{hasEarlier && onLoadEarlier && (
					<Button
						type="button"
						size="sm"
						variant="ghost"
						disabled={loadingEarlier}
						onClick={onLoadEarlier}
					>
						以前の記録を読む
					</Button>
				)}
				{entries.length === 0 ? (
					<p>{emptyText}</p>
				) : (
					<ol>
						{entries.map((entry) => (
							<li key={entry.id} data-status={entry.status}>
								<time dateTime={entry.at}>{time(entry.at)}</time>
								<span>{entry.title}</span>
								{entry.status && (
									<span className="activity-timeline-status">
										{statusLabels[entry.status]}
									</span>
								)}
								{entry.detail && (
									<details>
										<summary>詳細</summary>
										<pre>{entry.detail}</pre>
									</details>
								)}
								{entry.truncated && (
									<p>表示できる長さを超えたため、一部を省略しています</p>
								)}
							</li>
						))}
					</ol>
				)}
			</div>
		</section>
	);
}
