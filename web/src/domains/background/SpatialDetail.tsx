import { useEffect, useState } from "react";
import { healthLabels, type SpatialItem, type SpatialState } from "./contracts";
import { healthColors } from "./options";

const activityLabels: Record<SpatialState["activity"], string> = {
	idle: "待機",
	starting: "準備中",
	working: "処理中",
};
const sourceLabels: Record<NonNullable<SpatialState["source"]>, string> = {
	measurement: "実測",
	demo: "デモ値",
	unconfirmed: "未確認",
};
function observed(at: number | undefined, now: number) {
	if (at === undefined) return "未取得";
	const seconds = Math.max(0, Math.floor((now - at) / 1000));
	return `${new Date(at).toLocaleTimeString()}（${seconds}秒前）`;
}

/** One item's owner-supplied state; shared by the click panel and the fallback list. */
export function SpatialDetail({
	item,
	demo,
}: {
	item: SpatialItem;
	/** Per-item demo values, editable only while demo mode is on. */
	demo?: { override(next: Partial<SpatialState>): void; reset(): void };
}) {
	const { state } = item;
	// The age keeps counting while the panel stays open between monitoring updates.
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (state.observedAt === undefined) return;
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [state.observedAt]);
	return (
		<div className="spatial-detail-body">
			<p className="spatial-detail-health">
				<i
					style={{ background: healthColors[state.health] }}
					aria-hidden="true"
				/>
				<span>
					{healthLabels[state.health]}
					{state.stale ? "（情報が古い）" : ""}
				</span>
				<span className="spatial-detail-source">
					{sourceLabels[state.source ?? "unconfirmed"]}
				</span>
			</p>
			<dl>
				<dt>活動</dt>
				<dd>{activityLabels[state.activity]}</dd>
				<dt>利用率</dt>
				<dd>
					{state.utilization === undefined
						? "未取得"
						: `${Math.round(state.utilization * 100)}%`}
				</dd>
				<dt>観測</dt>
				<dd>{observed(state.observedAt, now)}</dd>
			</dl>
			{state.details?.length ? (
				<ul className="spatial-detail-notes">
					{state.details.map((note, index) => (
						<li key={index}>{note}</li>
					))}
				</ul>
			) : null}
			{demo && (
				<fieldset>
					<legend>このモデルのデモ値</legend>
					<label>
						health
						<select
							aria-label="health"
							value={state.health}
							onChange={(e) =>
								demo.override({
									health: e.target.value as SpatialState["health"],
								})
							}
						>
							{Object.entries(healthLabels).map(([key, label]) => (
								<option key={key} value={key}>
									{label}
								</option>
							))}
						</select>
					</label>
					<label>
						活動
						<select
							value={state.activity}
							onChange={(e) =>
								demo.override({
									activity: e.target.value as SpatialState["activity"],
								})
							}
						>
							{Object.entries(activityLabels).map(([key, label]) => (
								<option key={key} value={key}>
									{label}
								</option>
							))}
						</select>
					</label>
					<label>
						利用率
						<input
							type="range"
							min="0"
							max="100"
							value={(state.utilization ?? 0) * 100}
							onChange={(e) =>
								demo.override({
									utilization: Number(e.target.value) / 100,
								})
							}
						/>
					</label>
					<button type="button" onClick={demo.reset}>
						共通のデモ値に戻す
					</button>
				</fieldset>
			)}
		</div>
	);
}
