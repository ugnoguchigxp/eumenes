import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import type { EumenesClient } from "../../../../client";
import { operationLabels } from "./configuration";
import type { Project } from "../../../../api/domains/dots/contracts";
import type { CreateTask } from "../../../../api/domains/tasks/contracts";
export function TaskPanel({
	client,
	projects,
}: {
	client: EumenesClient;
	projects: Project[];
}) {
	const q = useInfiniteQuery({
		queryKey: ["dots-tasks", client.identity],
		initialPageParam: "",
		queryFn: ({ pageParam }) =>
			client.workTasks({ cursor: pageParam || undefined, limit: 50 }),
		getNextPageParam: (p) => p.nextCursor ?? undefined,
		retry: false,
		refetchInterval: 5000,
	});
	const [selected, setSelected] = useState("");
	return (
		<section>
			<h3>委任した作業</h3>
			<NewTask
				client={client}
				projects={projects}
				saved={(id) => {
					setSelected(id);
					void q.refetch();
				}}
			/>
			{q.isError && <p role="alert">作業の一覧を取得できませんでした。</p>}
			<ul>
				{q.data?.pages
					.flatMap((p) => p.items)
					.filter((t) => t.kind === "orchestration")
					.map((t) => (
						<li key={t.id}>
							<button onClick={() => setSelected(t.id)}>
								{t.title} · {stateLabel[t.state]}
							</button>
						</li>
					))}
			</ul>
			{q.hasNextPage && (
				<button
					disabled={q.isFetchingNextPage}
					onClick={() => void q.fetchNextPage()}
				>
					続きを表示
				</button>
			)}
			{selected && <TaskDetail key={selected} client={client} id={selected} />}
		</section>
	);
}
const stateLabel = {
	registered: "登録済み",
	queued: "受領待ち",
	active: "作業中",
	waiting_user: "回答待ち",
	paused: "一時停止",
	reconciling: "再開状況を確認中",
	stopping: "停止確認待ち",
	completed: "完了報告あり",
	failed: "失敗報告あり",
	cancelled: "取消済み",
};
function NewTask({
	client,
	projects,
	saved,
}: {
	client: EumenesClient;
	projects: Project[];
	saved: (id: string) => void;
}) {
	const [projectRef, setProject] = useState(""),
		[title, setTitle] = useState(""),
		[request, setRequest] = useState(""),
		[conditions, setConditions] = useState(""),
		[busy, setBusy] = useState(false),
		[error, setError] = useState(""),
		[maxSessions, setMax] = useState(1);
	const pending = useRef<CreateTask | null>(null);
	const project = projects.find((p) => p.ref === projectRef);
	async function submit() {
		if (!project || busy) return;
		setBusy(true);
		setError("");
		try {
			pending.current ??= {
				kind: "orchestration",
				version: 1,
				requestId: crypto.randomUUID(),
				title,
				request,
				completionConditions: conditions
					.split("\n")
					.map((s) => s.trim())
					.filter(Boolean),
				startMode: "start",
				grant: {
					connectionRef: project.connectionRef,
					projectRef: project.ref,
					operations: project.allowedOperations,
					maxSessions,
					expiresAt: new Date(Date.now() + 7200000).toISOString(),
				},
			};
			const r = await client.createTask(pending.current);
			pending.current = null;
			saved(r.taskId);
			setTitle("");
			setRequest("");
			setConditions("");
		} catch {
			setError(
				"登録を確認できませんでした。同じ内容でもう一度送ると、保存済みの受付を確認できます。",
			);
		} finally {
			setBusy(false);
		}
	}
	return (
		<details>
			<summary>作業を依頼</summary>
			<form
				onChange={() => {
					if (!busy) pending.current = null;
				}}
				onSubmit={(e) => {
					e.preventDefault();
					void submit();
				}}
			>
				<label>
					プロジェクト
					<select
						required
						disabled={busy}
						value={projectRef}
						onChange={(e) => setProject(e.target.value)}
					>
						<option value="">選択</option>
						{projects.map((p) => (
							<option key={p.ref} value={p.ref}>
								{p.title}
							</option>
						))}
					</select>
				</label>
				<label>
					作業名
					<input
						required
						disabled={busy}
						value={title}
						maxLength={120}
						onChange={(e) => setTitle(e.target.value)}
					/>
				</label>
				<label>
					依頼
					<textarea
						required
						disabled={busy}
						value={request}
						maxLength={8000}
						onChange={(e) => setRequest(e.target.value)}
					/>
				</label>
				<label>
					完了条件（1行に1つ）
					<textarea
						required
						disabled={busy}
						value={conditions}
						onChange={(e) => setConditions(e.target.value)}
					/>
				</label>
				<label>
					Session数の上限
					<input
						type="number"
						min={1}
						max={20}
						disabled={busy}
						value={maxSessions}
						onChange={(e) => setMax(Number(e.target.value))}
					/>
				</label>
				{project && (
					<p>
						許可する操作：
						{project.allowedOperations
							.map((op) => operationLabels[op])
							.join(" / ")}
						。実行期限は2時間です。
					</p>
				)}
				<output>{error}</output>
				<button disabled={busy || !project} type="submit">
					依頼を送る
				</button>
			</form>
		</details>
	);
}
function TaskDetail({ client, id }: { client: EumenesClient; id: string }) {
	const q = useQuery({
		queryKey: ["dots-task", client.identity, id],
		queryFn: () => client.workTask(id),
		refetchInterval: 3000,
		retry: false,
	});
	const sessions = useQuery({
		queryKey: ["dots-sessions", client.identity, id],
		queryFn: () => client.dotsTaskSessions(id),
		refetchInterval: 5000,
		retry: false,
	});
	const reports = useQuery({
		queryKey: ["dots-reports", client.identity, id],
		queryFn: () => client.taskReports(id),
		refetchInterval: 5000,
		retry: false,
	});
	const [draft, setDraft] = useState({ questionId: "", text: "" }),
		[error, setError] = useState(""),
		[busy, setBusy] = useState(false),
		[schedule, setSchedule] = useState(""),
		[scheduleReceipt, setScheduleReceipt] = useState<{
			commandId: string;
			expiresAt: number;
			scheduleRef: string;
		} | null>(null);
	async function act(fn: () => Promise<unknown>) {
		if (busy) return;
		setBusy(true);
		setError("");
		try {
			await fn();
			await Promise.all([q.refetch(), sessions.refetch(), reports.refetch()]);
		} catch {
			setError("操作を確認できませんでした。現在の状態を読み直してください。");
			await q.refetch();
		} finally {
			setBusy(false);
		}
	}
	const detail = q.data;
	if (!detail)
		return (
			<output>
				{q.isError ? "作業を取得できませんでした。" : "作業を読み込み中…"}
			</output>
		);
	const t = detail.task,
		terminal = ["completed", "failed", "cancelled"].includes(t.state);
	const answer = draft.questionId === detail.question?.id ? draft.text : "";
	const setAnswer = (text: string) =>
		setDraft({ questionId: detail.question!.id, text });
	return (
		<article>
			<h4>{t.title}</h4>
			<p>{stateLabel[t.state]}</p>
			<output>{error}</output>
			{t.request && <p>{t.request}</p>}
			{detail.question && t.state === "waiting_user" && (
				<form
					onSubmit={(e) => {
						e.preventDefault();
						void act(() =>
							client.answerTask(id, {
								requestId: crypto.randomUUID(),
								expectedRevision: t.revision,
								questionId: detail.question!.id,
								answer,
							}),
						);
					}}
				>
					<label>
						{detail.question.prompt}
						{detail.question.answerType === "choice" ? (
							<select
								required
								value={answer}
								onChange={(e) => setAnswer(e.target.value)}
							>
								<option value="">選択</option>
								{detail.question.choices.map((c) => (
									<option key={c}>{c}</option>
								))}
							</select>
						) : (
							<textarea
								required
								value={answer}
								onChange={(e) => setAnswer(e.target.value)}
							/>
						)}
					</label>
					<button type="submit" disabled={busy}>
						回答して続行
					</button>
				</form>
			)}
			{["registered", "paused"].includes(t.state) && (
				<button
					disabled={busy}
					onClick={() =>
						void act(() =>
							client.startTask(id, crypto.randomUUID(), t.revision),
						)
					}
				>
					開始する
				</button>
			)}
			{!terminal && (
				<>
					<button
						disabled={busy || t.state === "stopping" || t.state === "paused"}
						onClick={() =>
							void act(() =>
								client.stopTask(id, crypto.randomUUID(), t.revision, "pause"),
							)
						}
					>
						一時停止
					</button>
					<button
						disabled={busy}
						onClick={() =>
							void act(() =>
								client.stopTask(id, crypto.randomUUID(), t.revision, "cancel"),
							)
						}
					>
						取消
					</button>
				</>
			)}
			{!t.forgottenAt && (
				<button
					disabled={busy}
					onClick={() =>
						void act(() =>
							client.forgetTask(id, crypto.randomUUID(), t.revision),
						)
					}
				>
					依頼の本文を削除
				</button>
			)}
			{t.result && <p>{t.result.summary}</p>}
			<details>
				<summary>Sessionと根拠</summary>
				{sessions.data?.sessions.map((s) => (
					<p key={s.threadId}>
						{s.threadId} · {s.projectId} · {s.hostId}
					</p>
				))}
				{reports.data?.items.map((r) => (
					<p key={r.id}>
						{r.summary}
						<br />
						{r.evidenceRefs.join(" · ")}
					</p>
				))}
				{reports.data?.nextCursor != null && (
					<p>
						報告の一覧は最初のページです。全件は作業の報告APIから確認できます。
					</p>
				)}
			</details>
			<details>
				<summary>登録済みのリマインドを紐付ける</summary>
				<p>
					Codexで作成済みの予定のIDを登録します。予定の作成・停止はCodex側で行います。Eumenesへの報告を7日間だけ受け付けます。
				</p>
				<input
					aria-label="予定ID"
					value={schedule}
					onChange={(e) => setSchedule(e.target.value)}
				/>
				<button
					disabled={busy || !schedule}
					onClick={() =>
						void act(async () => {
							const r = await client.bindDotsSchedule(id, schedule);
							setScheduleReceipt(r);
						})
					}
				>
					予定を紐付ける
				</button>
				{scheduleReceipt && (
					<label>
						Codexの予定に渡す指示
						<textarea
							readOnly
							value={`Eumenes の get_command で commandId=${scheduleReceipt.commandId} を取得し、同じUUID leaseで claim_command してください。毎回 get_task_snapshot を読み、次の sourceSequence とその予定の一意な occurrenceRef を使って report_task(kind=reminder, scheduleRef=${scheduleReceipt.scheduleRef}) で報告してください。新しい作業を開始する権限はありません。有効期限：${new Date(scheduleReceipt.expiresAt).toISOString()}`}
						/>
					</label>
				)}
			</details>
		</article>
	);
}
