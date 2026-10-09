import { Field, Toggle } from "../shared";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useState } from "react";
import { type EumenesClient } from "../../../../../client";
import { queryRoots } from "../../../queryKeys";
import { describeError } from "../../../errorMessages";
import {
	Button,
	Input,
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "../../../design-system";

export function SchedulePanel({ client }: { client: EumenesClient }) {
	const query = useInfiniteQuery({
		queryKey: [queryRoots.settingsSchedules, client.identity],
		initialPageParam: null as string | null,
		queryFn: ({ pageParam }) =>
			client.schedules({ limit: 100, cursor: pageParam ?? undefined }),
		getNextPageParam: (last) => last.nextCursor,
		retry: 0,
	});
	const [text, setText] = useState("");
	const [at, setAt] = useState("");
	const [interval, setInterval] = useState(false);
	const [minutes, setMinutes] = useState(60);
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const [selected, setSelected] = useState<string | null>(null);
	const occurrences = useInfiniteQuery({
		queryKey: [queryRoots.settingsOccurrences, client.identity, selected],
		initialPageParam: null as string | null,
		queryFn: ({ pageParam }) =>
			client.scheduleOccurrences(selected!, { cursor: pageParam ?? undefined }),
		getNextPageParam: (last) => last.nextCursor,
		enabled: !!selected,
		retry: 0,
	});
	async function act(fn: () => Promise<unknown>) {
		setBusy(true);
		setError("");
		try {
			await fn();
			await query.refetch();
		} catch (e) {
			setError(describeError(e));
		} finally {
			setBusy(false);
		}
	}
	return (
		<>
			<Card>
				<CardHeader>
					<CardTitle>会話を予約する</CardTitle>
				</CardHeader>
				<CardContent>
					<Field label="依頼内容">
						<Input value={text} onChange={(e) => setText(e.target.value)} />
					</Field>
					<Field label="実行日時（端末の時刻）">
						<Input
							type="datetime-local"
							value={at}
							onChange={(e) => setAt(e.target.value)}
						/>
					</Field>
					<Toggle
						label="固定間隔で繰り返す"
						value={interval}
						onChange={setInterval}
					/>
					{interval && (
						<Field label="間隔（分）">
							<Input
								type="number"
								min={1}
								value={minutes}
								onChange={(e) => setMinutes(Number(e.target.value))}
							/>
						</Field>
					)}
					<Button
						disabled={busy || !text.trim() || !at}
						onClick={() =>
							void act(async () => {
								const iso = new Date(at).toISOString();
								await client.createSchedule({
									requestId: crypto.randomUUID(),
									target: {
										kind: "dialogue.prompt",
										payload: { conversationId: "main", text },
									},
									schedule: interval
										? {
												type: "interval",
												anchor: iso,
												intervalMs: minutes * 60000,
											}
										: { type: "once", at: iso },
								});
								setText("");
							})
						}
					>
						予約を作成
					</Button>
					<p className="hint">
						Eumenesが起動している間に実行します。過ぎた予約は既存の予約処理の規則に従います。
					</p>
				</CardContent>
			</Card>
			{error && <p role="alert">{error}</p>}
			{query.isError && <p role="alert">予約を読み込めません。</p>}
			{query.data?.pages
				.flatMap((p) => p.items)
				.map((s) => (
					<Card key={s.id}>
						<CardContent>
							<p>
								{(s.targetPayload as { text?: string }).text ?? s.targetKind}
							</p>
							<p className="hint">
								{s.state} / 次回: {s.nextDueAt ?? "なし"}
							</p>
							<div className="settings-actions">
								{s.state === "active" && (
									<Button
										variant="secondary"
										disabled={busy}
										onClick={() =>
											void act(() => client.pauseSchedule(s.id, s.revision))
										}
									>
										一時停止
									</Button>
								)}
								{s.state === "paused" && (
									<Button
										variant="secondary"
										disabled={busy}
										onClick={() =>
											void act(() => client.resumeSchedule(s.id, s.revision))
										}
									>
										再開
									</Button>
								)}
								{["active", "paused"].includes(s.state) && (
									<Button
										variant="secondary"
										disabled={busy}
										onClick={() =>
											void act(() => client.cancelSchedule(s.id, s.revision))
										}
									>
										今後の予約を取消
									</Button>
								)}
								<Button variant="secondary" onClick={() => setSelected(s.id)}>
									実行履歴
								</Button>
							</div>
							<p className="hint">
								予約を取り消しても、受付済みの会話は続きます。会話の「実行記録」から取り消せます。
							</p>
						</CardContent>
					</Card>
				))}
			{query.hasNextPage && (
				<Button
					variant="secondary"
					disabled={query.isFetchingNextPage}
					onClick={() => void query.fetchNextPage()}
				>
					続きを読み込む
				</Button>
			)}
			{selected && (
				<section>
					<h3>予約の実行履歴</h3>
					{occurrences.data?.pages
						.flatMap((p) => p.items)
						.map((o) => (
							<p key={o.id}>
								{o.scheduledAt}: {o.state} / {o.jobState ?? o.reason ?? "—"}
							</p>
						))}
					{occurrences.hasNextPage && (
						<Button
							disabled={occurrences.isFetchingNextPage}
							onClick={() => void occurrences.fetchNextPage()}
						>
							履歴の続きを読み込む
						</Button>
					)}
				</section>
			)}
		</>
	);
}
