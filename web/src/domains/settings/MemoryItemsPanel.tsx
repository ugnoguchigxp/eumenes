import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import type { EumenesClient } from "../../../../client";
import { ApiError } from "../../../../client/transport";
import {
	Badge,
	Button,
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "../../design-system";
import { queryRoots } from "../../queryKeys";

type Client = Pick<
	EumenesClient,
	| "identity"
	| "memoryStatus"
	| "memoryItems"
	| "memoryAction"
	| "forgetItem"
	| "memoryShortTerm"
	| "continuityTransition"
	| "memoryTendencies"
	| "deleteTendency"
	| "memoryContext"
>;
type Item = Awaited<ReturnType<Client["memoryItems"]>>[number];
type Note = Awaited<ReturnType<Client["memoryShortTerm"]>>[number];

const kindLabels: Record<string, string> = {
	preference: "好み",
	personal_fact: "本人の事実",
	constraint: "制約",
	habit: "習慣",
};
const statusLabels: Record<string, string> = {
	active: "利用中",
	inactive: "停止中",
	superseded: "置き換え済み",
	disputed: "内容に争いあり",
	retracted: "撤回済み",
	invalidated: "根拠が失われ無効",
	forgotten: "消去済み",
};
const UNKNOWN_STATUS = "不明な状態";
const capturedByLabels: Record<Item["capturedBy"], string> = {
	request: "頼まれて記憶",
	agent: "会話から自動で記憶",
	manual: "手動登録",
};
const noteKindLabels: Record<Note["kind"], string> = {
	goal: "目的",
	decision: "決定",
	open_question: "未解決",
	activity: "活動",
	memo: "メモ",
};
const NO_QUOTE = "元の発言は見つかりません";

const roots = [
	queryRoots.memoryItems,
	queryRoots.memoryShortTerm,
	queryRoots.memoryTendencies,
	queryRoots.memoryContext,
] as const;

function errorText(e: unknown) {
	const code = e instanceof Error ? e.message : "";
	if (code === "revision_conflict")
		return "他で変更されました。読み直してください";
	if (code === "memory_forget_incomplete")
		return "一部だけ消えました。もう一度『完全に消す』を押してください";
	if (e instanceof ApiError && e.status === 404)
		return "対象が見つかりません。読み直してください";
	return "操作を確認できませんでした。読み直してから、もう一度お試しください。";
}
const date = (ms: number) => new Date(ms).toLocaleDateString("ja-JP");
function validityText(item: Item) {
	const from =
		item.validity?.from ?? (item.validFromMs ? date(item.validFromMs) : "");
	const until =
		item.validity?.until ?? (item.validUntilMs ? date(item.validUntilMs) : "");
	return from || until ? `${from}〜${until}` : "";
}
const itemText = (item: Item) =>
	item.polarity === "negated" ? `「${item.text}」ではない` : item.text;

export function MemoryItemsPanel({
	client,
	conversationId,
}: {
	client: Client;
	conversationId: string;
}) {
	const cache = useQueryClient();
	const [history, setHistory] = useState(false);
	const [autoOnly, setAutoOnly] = useState(false);
	const [confirming, setConfirming] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [noteError, setNoteError] = useState("");

	const pending = useRef(false);
	const status = useQuery({
		queryKey: [queryRoots.memoryStatus, client.identity],
		queryFn: () => client.memoryStatus(),
		retry: false,
	});
	const healthy = status.data?.healthy === true && !status.isError;
	const items = useQuery({
		queryKey: [queryRoots.memoryItems, client.identity, history],
		queryFn: () => client.memoryItems(history),
		enabled: healthy,
		retry: false,
	});
	const tendencies = useQuery({
		queryKey: [queryRoots.memoryTendencies, client.identity],
		queryFn: () => client.memoryTendencies(),
		enabled: healthy,
		retry: false,
	});
	const shortTerm = useQuery({
		queryKey: [queryRoots.memoryShortTerm, client.identity, conversationId],
		queryFn: () => client.memoryShortTerm(conversationId),
		enabled: healthy,
		retry: false,
	});
	const context = useQuery({
		queryKey: [queryRoots.memoryContext, client.identity, conversationId],
		queryFn: () => client.memoryContext(conversationId),
		enabled: healthy,
		retry: false,
		refetchOnWindowFocus: false,
	});
	async function reload() {
		await Promise.all(
			roots.map((root) => cache.invalidateQueries({ queryKey: [root] })),
		);
	}
	/** Stays busy until the reload finishes, so a stale row cannot be acted on. */
	async function act(
		operation: () => Promise<unknown>,
		fail: (text: string) => void = setError,
	) {
		if (pending.current) return;
		pending.current = true;
		setBusy(true);
		setError("");
		setNoteError("");
		try {
			try {
				await operation();
			} catch (e) {
				fail(errorText(e));
			}
			await reload().catch(() => undefined);
		} finally {
			pending.current = false;
			setBusy(false);
		}
	}
	const forget = (item: Item) =>
		act(async () => {
			setConfirming("");
			const result = await client.forgetItem(item.id);
			if (!result.completed) throw new Error("memory_forget_incomplete");
		});
	const visible = (items.data ?? []).filter(
		(item) => !autoOnly || item.capturedBy === "agent",
	);
	return (
		<>
			<Card>
				<CardHeader>
					<CardTitle>いつも使う記憶（長期）</CardTitle>
				</CardHeader>
				<CardContent>
					{error && <p role="alert">{error}</p>}
					{!healthy ? (
						<p>
							{status.data && !status.data.healthy
								? "保存した記憶の整合性を確認できないため、一覧は表示しません。"
								: status.isError
									? "接続状態を確認できないため、一覧は表示しません。"
									: "読み込み中…"}
						</p>
					) : (
						<>
							<p>
								<label>
									<input
										type="checkbox"
										checked={history}
										onChange={(e) => setHistory(e.target.checked)}
									/>{" "}
									履歴も表示
								</label>{" "}
								<label>
									<input
										type="checkbox"
										checked={autoOnly}
										onChange={(e) => setAutoOnly(e.target.checked)}
									/>{" "}
									自動で記憶したものだけ
								</label>
							</p>
							{items.isError ? (
								<p role="alert">記憶の一覧を読み込めません。</p>
							) : !items.data ? (
								<p>読み込み中…</p>
							) : visible.length === 0 ? (
								<p>表示できる記憶はありません。</p>
							) : (
								<ul>
									{visible.map((item) => (
										<li key={item.id}>
											<p>
												<Badge variant="outline">
													{kindLabels[item.kind] ?? item.kind}
												</Badge>{" "}
												<Badge variant="secondary">
													{statusLabels[item.status] ?? UNKNOWN_STATUS}
												</Badge>{" "}
												<Badge variant="outline">
													{capturedByLabels[item.capturedBy]}
												</Badge>
											</p>
											<p>{itemText(item)}</p>
											{validityText(item) && (
												<p className="hint">期間: {validityText(item)}</p>
											)}
											{item.evidence.length === 0 ? (
												<p className="hint">{NO_QUOTE}</p>
											) : (
												item.evidence.map((e, index) => (
													<p className="hint" key={`${e.messageId}:${index}`}>
														{e.quote ? `「${e.quote}」` : NO_QUOTE}
													</p>
												))
											)}
											<p>
												{item.status === "active" && (
													<Button
														variant="secondary"
														disabled={busy}
														aria-label={`「${item.text}」の利用を止める`}
														onClick={() =>
															void act(() =>
																client.memoryAction(
																	item.id,
																	"stop",
																	item.revision,
																),
															)
														}
													>
														利用を止める
													</Button>
												)}
												{item.status === "inactive" && (
													<Button
														variant="secondary"
														disabled={busy}
														aria-label={`「${item.text}」の利用を再開する`}
														onClick={() =>
															void act(() =>
																client.memoryAction(
																	item.id,
																	"resume",
																	item.revision,
																),
															)
														}
													>
														再開する
													</Button>
												)}{" "}
												{confirming === `item:${item.id}` ? (
													<>
														<span>
															完全に消すと元に戻せません。よろしいですか？
														</span>{" "}
														<Button
															variant="destructive"
															disabled={busy}
															aria-label={`「${item.text}」を本当に完全に消す`}
															onClick={() => void forget(item)}
														>
															本当に完全に消す
														</Button>{" "}
														<Button
															variant="secondary"
															disabled={busy}
															aria-label={`「${item.text}」の削除をやめる`}
															onClick={() => setConfirming("")}
														>
															{" "}
															やめる
														</Button>
													</>
												) : (
													<Button
														variant="secondary"
														disabled={busy}
														aria-label={`「${item.text}」を完全に消す`}
														onClick={() => setConfirming(`item:${item.id}`)}
													>
														完全に消す
													</Button>
												)}
											</p>
										</li>
									))}
								</ul>
							)}
							<h4>傾向</h4>
							{tendencies.isError ? (
								<p role="alert">傾向を読み込めません。</p>
							) : !tendencies.data ? (
								<p>読み込み中…</p>
							) : tendencies.data.length === 0 ? (
								<p>記録された傾向はありません。</p>
							) : (
								<ul>
									{tendencies.data.map((t) => (
										<li key={t.id}>
											<span>{t.text}</span>{" "}
											{confirming === `tendency:${t.id}` ? (
												<>
													<span>
														削除すると元に戻せません。よろしいですか？
													</span>{" "}
													<Button
														variant="destructive"
														disabled={busy}
														aria-label={`傾向「${t.text}」を本当に削除`}
														onClick={() =>
															void act(async () => {
																setConfirming("");
																await client.deleteTendency(t.id);
															})
														}
													>
														本当に削除
													</Button>{" "}
													<Button
														variant="secondary"
														disabled={busy}
														aria-label={`傾向「${t.text}」の削除をやめる`}
														onClick={() => setConfirming("")}
													>
														やめる
													</Button>
												</>
											) : (
												<Button
													variant="secondary"
													disabled={busy}
													aria-label={`傾向「${t.text}」を削除`}
													onClick={() => setConfirming(`tendency:${t.id}`)}
												>
													傾向を削除
												</Button>
											)}
										</li>
									))}
								</ul>
							)}
						</>
					)}
				</CardContent>
			</Card>
			{healthy && (
				<>
					<Card>
						<CardHeader>
							<CardTitle>最近の活動・メモ（短期）</CardTitle>
						</CardHeader>
						<CardContent>
							{noteError && <p role="alert">{noteError}</p>}
							{shortTerm.isError ? (
								<p role="alert">短期の記憶を読み込めません。</p>
							) : !shortTerm.data ? (
								<p>読み込み中…</p>
							) : shortTerm.data.length === 0 ? (
								<p>最近の活動・メモはありません。</p>
							) : (
								<ul>
									{shortTerm.data.map((note) => (
										<li key={note.id}>
											<Badge variant="outline">
												{noteKindLabels[note.kind]}
											</Badge>{" "}
											<span>{note.text}</span>{" "}
											<Button
												variant="secondary"
												disabled={busy}
												aria-label={`「${note.text}」を完了にする`}
												onClick={() =>
													void act(
														() =>
															client.continuityTransition(
																note.id,
																"resolved",
																note.revision,
															),
														setNoteError,
													)
												}
											>
												{" "}
												完了にする
											</Button>{" "}
											<Button
												variant="secondary"
												disabled={busy}
												aria-label={`「${note.text}」を取り消す`}
												onClick={() =>
													void act(
														() =>
															client.continuityTransition(
																note.id,
																"retracted",
																note.revision,
															),
														setNoteError,
													)
												}
											>
												{" "}
												取り消す
											</Button>
										</li>
									))}
								</ul>
							)}
						</CardContent>
					</Card>
					<Card>
						<CardHeader>
							<CardTitle>いまの文脈</CardTitle>
						</CardHeader>
						<CardContent>
							{context.isError ? (
								<p role="alert">いまの文脈を読み込めません。</p>
							) : !context.data ? (
								<p>読み込み中…</p>
							) : context.data.disabled ? (
								<p>メモリーを利用していないため、文脈は組み立てていません。</p>
							) : (
								<>
									<p>版 {context.data.version}</p>
									<p>
										長期: {context.data.longTerm.bytes} /{" "}
										{context.data.longTerm.limit} byte
									</p>
									<p>
										短期: {context.data.shortTerm.bytes} /{" "}
										{context.data.shortTerm.limit} byte （追加待ち{" "}
										{context.data.shortTerm.pendingAdditions} 件）
									</p>
									<p>次の会話で伝える通知: {context.data.notices} 件</p>
									<details>
										<summary>長期の本文</summary>
										<pre>{context.data.longTerm.text || "（空）"}</pre>
									</details>
									<details>
										<summary>短期の本文</summary>
										<pre>{context.data.shortTerm.text || "（空）"}</pre>
									</details>
								</>
							)}
							<Button
								variant="secondary"
								disabled={busy}
								onClick={() => void reload()}
							>
								読み直す
							</Button>
						</CardContent>
					</Card>
				</>
			)}
		</>
	);
}
