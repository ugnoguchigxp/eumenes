import { useEffect, useRef, useState } from "react";
import {
	useInfiniteQuery,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { ApiError, type EumenesClient } from "../../../../client";
import type {
	DraftState,
	RouteState,
	RouteSummaryDTO,
} from "../../../../api/domains/research-routes/contracts";
import { Button } from "../../design-system";
import { queryRoots } from "../../queryKeys";
import "./style.css";

export const stateLabels: Record<RouteState, string> = {
	unregistered: "未登録",
	preparing: "準備中",
	active: "利用中",
	suspended: "停止中（取得に失敗）",
	expired: "期限切れ（次回は検索から）",
	disabled: "停止",
};
export const draftLabels: Record<DraftState, string> = {
	queued: "登録待ち",
	authoring: "手順を作成中",
	reviewing: "内容を確認中",
	activated: "登録済み",
	rejected: "登録できませんでした",
	interrupted: "中断されました",
	superseded: "新しい版に置き換わりました",
};
const targetText = (t: RouteSummaryDTO["target"]) =>
	"name" in t
		? `${t.name}（${t.prefecture}）`
		: `${t.ticker} / ${t.market} / ${t.currency}`;
function errorText(error: unknown) {
	if (error instanceof ApiError) {
		if (error.status === 409)
			return "他の操作で状態が変わりました。最新の状態を読み込みました。";
		if (error.status === 404) return "この取得先はすでに削除されています。";
		if (error.status === 429)
			return "いま受け付けられません。少し待ってください。";
		if (error.status === 400) return "入力内容を確認してください。";
	}
	return "操作できませんでした。";
}

function Detail({
	client,
	routeKey,
	disabled,
	onDirty,
	onGone,
}: {
	client: EumenesClient;
	routeKey: string;
	disabled: boolean;
	onDirty: (dirty: boolean) => void;
	onGone: () => void;
}) {
	const cache = useQueryClient();
	const [instruction, setInstruction] = useState("");
	const [notice, setNotice] = useState("");
	const detailKey = [
		queryRoots.researchRoutes,
		client.identity,
		"detail",
		routeKey,
	];
	const detail = useQuery({
		queryKey: detailKey,
		queryFn: ({ signal }) => client.researchRoute(routeKey, signal),
		retry: 0,
	});
	const gone = detail.error instanceof ApiError && detail.error.status === 404;
	useEffect(() => {
		if (!gone) return;
		cache.removeQueries({ queryKey: detailKey, exact: true });
		onDirty(false);
		onGone();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [gone]);
	useEffect(() => {
		onDirty(instruction.trim().length > 0);
		return () => onDirty(false);
	}, [instruction, onDirty]);
	const refresh = () =>
		cache.invalidateQueries({ queryKey: [queryRoots.researchRoutes] });
	const onError = (error: unknown) => {
		setNotice(errorText(error));
		void refresh();
	};
	const token = detail.data?.stateToken;
	const disable = useMutation({
		mutationFn: () =>
			client.disableResearchRoute(routeKey, {
				requestId: crypto.randomUUID(),
				expectedStateToken: token!,
			}),
		onSuccess: () => {
			setNotice("この取得先を停止しました。");
			void refresh();
		},
		onError,
	});
	const rediscover = useMutation({
		mutationFn: () =>
			client.rediscoverResearchRoute(routeKey, {
				requestId: crypto.randomUUID(),
				expectedStateToken: token!,
			}),
		onSuccess: () => {
			setNotice("次回の依頼で取得先を探し直します。");
			void refresh();
		},
		onError,
	});
	const edit = useMutation({
		mutationFn: () =>
			client.editResearchRoute(routeKey, {
				requestId: crypto.randomUUID(),
				expectedStateToken: token!,
				instruction: instruction.trim(),
			}),
		onSuccess: () => {
			setInstruction("");
			setNotice("編集を受け付けました。確認が済むまで現在の手順を使います。");
			void refresh();
		},
		onError,
	});
	if (gone) return null;
	if (detail.isPending) return <p>読み込み中…</p>;
	if (detail.isError) return <p role="alert">詳細を読み込めませんでした。</p>;
	const d = detail.data;
	const busy = disable.isPending || rediscover.isPending || edit.isPending;
	const canEdit = d.state === "active";
	return (
		<section className="route-detail" aria-label={`取得先 ${d.keywords}`}>
			<h3>{d.keywords}</h3>
			<dl>
				<dt>対象</dt>
				<dd>{targetText(d.target)}</dd>
				<dt>状態</dt>
				<dd>{stateLabels[d.state]}</dd>
				<dt>取得先</dt>
				<dd>{d.sourceUrl ?? "なし"}</dd>
				<dt>最終成功</dt>
				<dd>
					{d.lastSuccessAt
						? new Date(d.lastSuccessAt).toLocaleString("ja-JP")
						: "なし"}
				</dd>
			</dl>
			{d.draftStatus && (
				<output className="route-draft">
					{draftLabels[d.draftStatus.state]}
					{d.draftStatus.errorCode ? `（${d.draftStatus.errorCode}）` : ""}
				</output>
			)}
			{d.skillRevision?.body != null && (
				<details>
					<summary>手順（SKILL）</summary>
					<pre>{d.skillRevision.body}</pre>
				</details>
			)}
			{d.contextProjection != null && (
				<details>
					<summary>会話に渡す内容（SystemContext）</summary>
					<pre>{d.contextProjection}</pre>
				</details>
			)}
			<div className="route-actions">
				<Button
					variant="secondary"
					disabled={disabled || busy || d.state === "disabled"}
					onClick={() => disable.mutate()}
				>
					この取得先を停止
				</Button>
				<Button
					variant="secondary"
					disabled={disabled || busy}
					onClick={() => rediscover.mutate()}
				>
					次回は取得先を探し直す
				</Button>
			</div>
			{canEdit && (
				<form
					onSubmit={(e) => {
						e.preventDefault();
						if (instruction.trim()) edit.mutate();
					}}
				>
					<label>
						手順の説明を編集（取得先・対象は変わりません）
						<textarea
							value={instruction}
							maxLength={2000}
							rows={4}
							onChange={(e) => setInstruction(e.target.value)}
						/>
					</label>
					<Button disabled={disabled || busy || !instruction.trim()}>
						編集を依頼
					</Button>
				</form>
			)}
			{notice && <output>{notice}</output>}
		</section>
	);
}

export function ResearchRoutesPanel({
	client,
	disabled = false,
	onDirty,
}: {
	client: EumenesClient;
	disabled?: boolean;
	onDirty: (dirty: boolean) => void;
}) {
	const cache = useQueryClient();
	const [selected, setSelected] = useState<string | null>(null);
	const [notice, setNotice] = useState("");
	const [confirmClear, setConfirmClear] = useState(false);
	const list = useInfiniteQuery({
		queryKey: [queryRoots.researchRoutes, client.identity, "list"],
		queryFn: ({ pageParam, signal }) =>
			client.researchRoutes(pageParam ? { cursor: pageParam } : {}, signal),
		initialPageParam: "",
		getNextPageParam: (last) => last.nextCursor ?? undefined,
		retry: 0,
	});
	const first = list.data?.pages[0];
	const epoch = first?.epoch;
	const items = list.data?.pages.flatMap((p) => p.items) ?? [];
	const stale = list.error instanceof ApiError && list.error.status === 409;
	const clear = useMutation({
		mutationFn: () =>
			client.clearResearchRoutes({
				requestId: crypto.randomUUID(),
				expectedEpoch: epoch!,
			}),
		onSuccess: (r) => {
			setSelected(null);
			setConfirmClear(false);
			setNotice(`${r.deletedKeys}件の取得先を削除しました。`);
			cache.removeQueries({
				queryKey: [queryRoots.researchRoutes, client.identity, "detail"],
			});
			void cache.invalidateQueries({ queryKey: [queryRoots.researchRoutes] });
		},
		onError: (error) => {
			setNotice(errorText(error));
			void cache.invalidateQueries({ queryKey: [queryRoots.researchRoutes] });
		},
	});
	const lastDirty = useRef(false);
	const report = (v: boolean) => {
		if (lastDirty.current === v) return;
		lastDirty.current = v;
		onDirty(v);
	};
	useEffect(() => () => onDirty(false), [onDirty]);
	return (
		<div className="route-panel">
			{list.isPending && <p>読み込み中…</p>}
			{(list.isError || stale) && (
				<p role="alert">
					{stale
						? errorText(list.error)
						: "取得先の一覧を読み込めませんでした。"}
				</p>
			)}
			{list.isSuccess && !items.length && (
				<p>登録された取得先はまだありません。</p>
			)}
			<ul className="route-list">
				{items.map((r) => (
					<li key={r.key}>
						<button
							type="button"
							aria-current={r.key === selected ? "true" : undefined}
							onClick={() => setSelected(r.key)}
						>
							<strong>{r.keywords}</strong>
							<span>{stateLabels[r.state]}</span>
							{r.draftStatus && (
								<small>{draftLabels[r.draftStatus.state]}</small>
							)}
						</button>
					</li>
				))}
			</ul>
			{list.hasNextPage && (
				<Button
					variant="secondary"
					disabled={list.isFetchingNextPage}
					onClick={() => void list.fetchNextPage()}
				>
					さらに表示
				</Button>
			)}
			{selected && (
				<Detail
					key={selected}
					client={client}
					routeKey={selected}
					disabled={disabled}
					onDirty={report}
					onGone={() => setSelected(null)}
				/>
			)}
			<div className="route-clear">
				{!confirmClear ? (
					<Button
						variant="secondary"
						disabled={disabled || epoch === undefined || clear.isPending}
						onClick={() => setConfirmClear(true)}
					>
						取得先をすべて削除
					</Button>
				) : (
					<>
						<p>保存した取得先と手順をすべて削除します。よろしいですか？</p>
						<Button disabled={clear.isPending} onClick={() => clear.mutate()}>
							削除する
						</Button>
						<Button variant="secondary" onClick={() => setConfirmClear(false)}>
							やめる
						</Button>
					</>
				)}
			</div>
			{notice && <output>{notice}</output>}
		</div>
	);
}
