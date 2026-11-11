import { Badge, Button } from "@eumenes/design-system";
import {
	Calendar,
	CalendarDays,
	ChevronDown,
	Clock3,
	MessageSquare,
	Pause,
	Repeat2,
} from "lucide-react";
import { useState } from "react";
import type { ArtifactRequest } from "./contracts";
import { useArtifactRuntime } from "./runtime";
import type { ScheduleAgendaItem } from "./schedule-agenda-contracts";
import "./schedule-agenda.css";

const filters = [
	["all", "すべて"],
	["active", "予約済み"],
	["recurring", "繰り返し"],
	["paused", "一時停止"],
] as const;
type Filter = (typeof filters)[number][0];
const emptyMessages: Record<Filter, string> = {
	all: "予約はまだありません",
	active: "実行予定の予約はありません",
	recurring: "繰り返しの予約はありません",
	paused: "一時停止中の予約はありません",
};
type Active = Extract<ScheduleAgendaItem, { state: "active" }>;
const timeZone = "Asia/Tokyo";
const dateLabel = new Intl.DateTimeFormat("ja-JP", {
	timeZone,
	year: "numeric",
	month: "long",
	day: "numeric",
	weekday: "short",
});
const clockLabel = new Intl.DateTimeFormat("ja-JP", {
	timeZone,
	hour: "2-digit",
	minute: "2-digit",
	hourCycle: "h23",
});

function orderedDays(items: Active[]) {
	const days = new Map<string, Active[]>();
	for (const item of items) {
		const label = dateLabel.format(Date.parse(item.nextDueAt));
		const day = days.get(label);
		if (day) day.push(item);
		else days.set(label, [item]);
	}
	return [...days];
}

function ScheduleMetadata({ item }: { item: ScheduleAgendaItem }) {
	const recurring = item.intervalMs !== null;
	const Icon = recurring ? Repeat2 : Calendar;
	return (
		<p className="aui-agenda-meta">
			<span>{item.kind}</span>
			<span aria-hidden="true">·</span>
			<span
				className="aui-agenda-cadence"
				data-recurring={recurring}
				title={recurring ? "繰り返し" : "一度きり"}
			>
				<Icon size={15} aria-hidden="true" />
				{item.interval}
			</span>
		</p>
	);
}

function RecurrencePreview({
	at,
	intervalMs,
}: {
	at: string;
	intervalMs: number;
}) {
	const next = Date.parse(at);
	return (
		<details className="aui-agenda-recurrence">
			<summary>
				今後3回の予定
				<ChevronDown size={15} aria-hidden="true" />
			</summary>
			<ol aria-label="次回から3回分の予定時刻">
				{[next, next + intervalMs, next + 2 * intervalMs].map((scheduled) => (
					<li key={scheduled}>
						<time dateTime={new Date(scheduled).toISOString()}>
							<span>{dateLabel.format(scheduled)}</span>
							<strong>{clockLabel.format(scheduled)}</strong>
						</time>
					</li>
				))}
			</ol>
		</details>
	);
}

function ScheduleRows({ items }: { items: readonly ScheduleAgendaItem[] }) {
	return (
		<ul className="aui-agenda-rows">
			{items.map((item) => (
				<li key={item.id} className="aui-agenda-row">
					{item.state === "active" ? (
						<time dateTime={item.nextDueAt} className="aui-agenda-time">
							{clockLabel.format(Date.parse(item.nextDueAt))}
						</time>
					) : (
						<span className="aui-agenda-paused-icon">
							<Pause aria-hidden="true" size={17} />
						</span>
					)}
					<div className="aui-agenda-item">
						<strong>{item.title}</strong>
						<ScheduleMetadata item={item} />
					</div>
					<Badge
						variant={item.state === "active" ? "outline" : "secondary"}
						className="aui-agenda-status"
						data-state={item.state}
					>
						{item.state === "active" ? "予約済み" : "一時停止"}
					</Badge>
					{item.state === "active" && item.intervalMs !== null && (
						<RecurrencePreview
							at={item.nextDueAt}
							intervalMs={item.intervalMs}
						/>
					)}
				</li>
			))}
		</ul>
	);
}

export function ScheduleAgendaView({ request }: { request: ArtifactRequest }) {
	const [filter, setFilter] = useState<Filter>("all");
	const { snapshot } = useArtifactRuntime();
	if (request.view !== "schedule-agenda") return null;
	const resource = snapshot[request.source];
	if (resource?.kind !== "schedule-agenda") return null;
	const active = resource.items
		.filter((item) => item.state === "active")
		.sort((a, b) => Date.parse(a.nextDueAt) - Date.parse(b.nextDueAt));
	const paused = resource.items.filter((item) => item.state === "paused");
	const next = active[0];
	const recurring = (item: ScheduleAgendaItem) =>
		filter !== "recurring" || item.intervalMs !== null;
	const visibleDays =
		filter === "paused" ? [] : orderedDays(active.filter(recurring));
	const visiblePaused = filter === "active" ? [] : paused.filter(recurring);
	const title = request.title ?? "実行予約";
	return (
		<section className="aui-schedule-agenda" aria-label={title}>
			<header className="aui-agenda-header">
				<span className="aui-agenda-icon">
					<CalendarDays size={22} aria-hidden="true" />
				</span>
				<div>
					<h2>{title}</h2>
					<p>会話とワークフローの予約を確認できます</p>
				</div>
				<span className="aui-agenda-zone">
					<Clock3 size={14} aria-hidden="true" />
					日本時間
				</span>
			</header>
			{next && (
				<section className="aui-agenda-next" aria-label="次の実行">
					<div className="aui-agenda-item">
						<p className="aui-agenda-eyebrow">次の実行</p>
						<h3>{next.title}</h3>
						<ScheduleMetadata item={next} />
					</div>
					<time dateTime={next.nextDueAt} className="aui-agenda-next-date">
						<strong>{clockLabel.format(Date.parse(next.nextDueAt))}</strong>
						<span>{dateLabel.format(Date.parse(next.nextDueAt))}</span>
					</time>
				</section>
			)}
			<fieldset className="aui-agenda-filterset">
				<legend className="sr-only">表示する予約</legend>
				<div className="aui-agenda-filters">
					{filters.map(([value, label]) => (
						<Button
							key={value}
							type="button"
							variant="ghost"
							size="sm"
							aria-pressed={filter === value}
							onClick={() => setFilter(value)}
						>
							{label}
						</Button>
					))}
				</div>
			</fieldset>
			<section className="aui-agenda-list" aria-label="予約一覧">
				{visibleDays.map(([date, items]) => (
					<section key={date}>
						<h3>{date}</h3>
						<ScheduleRows items={items} />
					</section>
				))}
				{visiblePaused.length > 0 && (
					<section>
						<h3>一時停止</h3>
						<ScheduleRows items={visiblePaused} />
					</section>
				)}
				{visibleDays.length === 0 && visiblePaused.length === 0 && (
					<output className="aui-agenda-empty">
						<CalendarDays aria-hidden="true" size={24} />
						<strong>{emptyMessages[filter]}</strong>
					</output>
				)}
			</section>
			<p className="aui-agenda-help">
				<MessageSquare aria-hidden="true" size={15} />
				会話の予約は会話から、ワークフローの予約は各アプリから登録できます。
			</p>
		</section>
	);
}
