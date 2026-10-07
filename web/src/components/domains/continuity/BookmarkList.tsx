import { useState } from "react";
import type { Bookmark } from "../../../../../api/domains/continuity/contracts";
import type { ContinuityClient } from "../../../../../client/continuity";
import {
	useBookmarkHistory,
	useBookmarks,
	useBookmarkSource,
	useDeactivateBookmark,
	useOperationRequestId,
} from "../../../domains/continuity";
import { Button } from "../../ui/Button";
import { ReviseBookmarkForm } from "./ReviseBookmarkForm";
import {
	kindLabels,
	operationLabels,
	originLabels,
	saveErrorMessage,
	sourceStatusLabels,
} from "./shared";

type Props = { client: ContinuityClient; conversationId: string };

function SourceViewer({
	client,
	conversationId,
	bookmarkId,
}: Props & { bookmarkId: string }) {
	const source = useBookmarkSource(client, conversationId, bookmarkId);
	if (source.isPending) return <p>出典を読み込み中…</p>;
	if (source.isError)
		return (
			<p role="alert">出典を取得できませんでした: {source.error.message}</p>
		);
	return (
		<div className="bookmark-source">
			<p>出典の状態: {sourceStatusLabels[source.data.status]}</p>
			{source.data.message ? (
				<blockquote>{source.data.message.text}</blockquote>
			) : (
				<p>元の発言は見つかりません。</p>
			)}
		</div>
	);
}

function HistoryViewer({
	client,
	conversationId,
	bookmarkId,
}: Props & { bookmarkId: string }) {
	const history = useBookmarkHistory(client, conversationId, bookmarkId);
	if (history.isPending) return <p>履歴を読み込み中…</p>;
	if (history.isError)
		return (
			<p role="alert">履歴を取得できませんでした: {history.error.message}</p>
		);
	return (
		<div className="bookmark-history">
			<ol>
				{history.data.pages.flatMap((page) =>
					page.events.map((event) => (
						<li key={event.id}>
							版{event.revision} {operationLabels[event.operation]}・
							{kindLabels[event.kind]}・
							{event.status === "inactive" ? "無効化済み・" : ""}
							{event.text}
						</li>
					)),
				)}
			</ol>
			{history.hasNextPage && (
				<Button
					type="button"
					onClick={() => history.fetchNextPage()}
					disabled={history.isFetchingNextPage}
				>
					さらに読み込む
				</Button>
			)}
		</div>
	);
}

function BookmarkItem({
	client,
	conversationId,
	bookmark,
}: Props & { bookmark: Bookmark }) {
	const [panel, setPanel] = useState<"revise" | "source" | "history" | null>(
		null,
	);
	const toggle = (next: NonNullable<typeof panel>) =>
		setPanel((current) => (current === next ? null : next));
	const deactivate = useDeactivateBookmark(client, conversationId, bookmark.id);
	const requestId = useOperationRequestId();
	const active = bookmark.status === "active";
	const submitDeactivate = () => {
		const payload = { expectedRevision: bookmark.revision };
		deactivate.mutate(
			{ requestId: requestId.idFor(payload), ...payload },
			{ onSuccess: () => requestId.reset() },
		);
	};
	return (
		<li className="bookmark-item">
			<strong>{kindLabels[bookmark.kind]}</strong>
			{!active && <span className="badge"> 無効化済み</span>}
			<p>{bookmark.text}</p>
			<small>
				版{bookmark.revision}
				{bookmark.origin === "user_edited" && ` ${originLabels.user_edited}`}
			</small>
			<div>
				{active && (
					<>
						<Button type="button" onClick={() => toggle("revise")}>
							訂正
						</Button>
						<Button
							type="button"
							onClick={submitDeactivate}
							disabled={deactivate.isPending}
						>
							無効化
						</Button>
					</>
				)}
				<Button type="button" onClick={() => toggle("source")}>
					出典
				</Button>
				<Button type="button" onClick={() => toggle("history")}>
					履歴
				</Button>
			</div>
			{deactivate.isError && (
				<p role="alert">{saveErrorMessage(deactivate.error)}</p>
			)}
			{panel === "revise" && (
				<ReviseBookmarkForm
					client={client}
					conversationId={conversationId}
					bookmark={bookmark}
					onDone={() => setPanel(null)}
				/>
			)}
			{panel === "source" && (
				<SourceViewer
					client={client}
					conversationId={conversationId}
					bookmarkId={bookmark.id}
				/>
			)}
			{panel === "history" && (
				<HistoryViewer
					client={client}
					conversationId={conversationId}
					bookmarkId={bookmark.id}
				/>
			)}
		</li>
	);
}

export function BookmarkList({ client, conversationId }: Props) {
	const [includeInactive, setIncludeInactive] = useState(false);
	const list = useBookmarks(client, conversationId, includeInactive);
	return (
		<section className="bookmark-list">
			<h3>しおり</h3>
			<label>
				<input
					type="checkbox"
					checked={includeInactive}
					onChange={(event) => setIncludeInactive(event.target.checked)}
				/>
				無効化済みも表示
			</label>
			{list.isPending && <p>読み込み中…</p>}
			{list.isError && (
				<p role="alert">しおりを取得できませんでした: {list.error.message}</p>
			)}
			{list.data &&
				(list.data.bookmarks.length === 0 ? (
					<p className="empty">しおりはありません。</p>
				) : (
					<ul>
						{list.data.bookmarks.map((bookmark) => (
							<BookmarkItem
								key={bookmark.id}
								client={client}
								conversationId={conversationId}
								bookmark={bookmark}
							/>
						))}
					</ul>
				))}
		</section>
	);
}
