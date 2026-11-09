import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "@eumenes/design-system";
import { useEffect, useState } from "react";
import type { ArtifactRequest } from "./contracts";

export function TextBlockView({ request }: { request: ArtifactRequest }) {
	if (request.view !== "text-block") return null;
	return (
		<section
			className="aui-text-block"
			data-emphasis={
				request.emphasis === "normal" ? undefined : request.emphasis
			}
		>
			<h2>{request.title}</h2>
			{request.body && <p>{request.body}</p>}
		</section>
	);
}
export function InfoCardView({ request }: { request: ArtifactRequest }) {
	if (request.view !== "info-card") return null;
	return (
		<Card>
			<CardHeader>
				<CardTitle>{request.title}</CardTitle>
			</CardHeader>
			<CardContent>
				<p>{request.body}</p>
			</CardContent>
		</Card>
	);
}

export function GroupedListView({ request }: { request: ArtifactRequest }) {
	const scheduleDate =
		request.view === "grouped-list" ? request.scheduleDate : undefined;
	const [now, setNow] = useState(Date.now);
	useEffect(() => {
		if (!scheduleDate) return;
		let timer: ReturnType<typeof setTimeout>;
		const tick = () => {
			const now = Date.now();
			setNow(now);
			timer = setTimeout(tick, 60_000 - (now % 60_000));
		};
		tick();
		return () => clearTimeout(timer);
	}, [scheduleDate]);
	if (request.view !== "grouped-list") return null;
	const elapsed = scheduleDate
		? Math.floor((now - Date.parse(`${scheduleDate}T00:00:00+09:00`)) / 60_000)
		: -1;
	return (
		<div
			className="aui-grouped-list"
			data-schedule={scheduleDate ? "" : undefined}
		>
			{request.groups.map(({ title, items }) => {
				const shared = scheduleDate ? sharedDetails(items) : [];
				const heading = title.normalize("NFKC").trimEnd();
				const notes = shared.filter((detail) => {
					if (!detail) return false;
					const value = detail.normalize("NFKC");
					return (
						!heading.endsWith(`[${value}]`) && !heading.endsWith(`(${value})`)
					);
				});
				const next = nextScreening(items, elapsed);
				return (
					<section key={title} className="aui-grouped-list-section">
						<h2>{title}</h2>
						{notes.length > 0 && (
							<p className="aui-grouped-list-note">{notes.join(" · ")}</p>
						)}
						<ul>
							{items.map(([label, ...details], index) => (
								<li key={index} data-next={index === next ? "" : undefined}>
									<strong>{label}</strong>
									{details.map((detail, index) =>
										detail && !shared[index] ? (
											<span key={index}>{detail}</span>
										) : null,
									)}
									{index === next && (
										<span className="aui-grouped-list-next">次回</span>
									)}
								</li>
							))}
						</ul>
					</section>
				);
			})}
		</div>
	);
}

function sharedDetails(items: string[][]) {
	return (items[0] ?? [])
		.slice(1)
		.map((detail, index) =>
			detail && items.every((item) => item[index + 1] === detail) ? detail : "",
		);
}

function nextScreening(items: string[][], elapsed: number) {
	if (elapsed < 0) return -1;
	let next = -1;
	let earliest = Infinity;
	for (const [index, [label]] of items.entries()) {
		const time = /^(\d{1,2}):([0-5]\d)$/.exec(label ?? "");
		if (!time) continue;
		const start = Number(time[1]) * 60 + Number(time[2]);
		if (start > elapsed && start < earliest) {
			next = index;
			earliest = start;
		}
	}
	return next;
}
