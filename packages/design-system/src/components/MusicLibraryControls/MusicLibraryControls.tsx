import { useEffect, useState } from "react";
import { Button } from "../Button";
import "./MusicLibraryControls.css";
export type MusicLibraryFilter = {
	q: string;
	tags: string[];
	favorite?: boolean;
	sort: "createdAt" | "relevance";
	order: "asc" | "desc";
};
export type MusicLibraryControlsProps = {
	filter: MusicLibraryFilter;
	tags: readonly { tag: string; count: number }[];
	loading?: boolean;
	error?: string;
	total?: number;
	hasMore?: boolean;
	onSearch: (filter: MusicLibraryFilter) => void;
	onMore: () => void;
	onRefresh: () => void;
	compact?: boolean;
};
export function MusicLibraryControls({
	filter,
	tags,
	loading,
	error,
	total,
	hasMore,
	onSearch,
	onMore,
	onRefresh,
	compact,
}: MusicLibraryControlsProps) {
	const [draft, setDraft] = useState(filter);
	// oxlint-disable-next-line react/set-state-in-effect -- local state follows a prop or open state, reset when it changes
	useEffect(() => setDraft(filter), [filter]);
	return (
		<section
			className={`music-library-controls${compact ? " music-library-controls-compact" : ""}`}
			aria-label="楽曲ライブラリ検索"
		>
			<form
				onSubmit={(e) => {
					e.preventDefault();
					onSearch(draft);
				}}
			>
				<label>
					検索
					<input
						value={draft.q}
						maxLength={512}
						onChange={(e) => setDraft({ ...draft, q: e.target.value })}
						placeholder="曲名・説明・歌詞・タグ"
					/>
				</label>
				<label>
					表示
					<select
						value={
							draft.favorite === undefined
								? "all"
								: draft.favorite
									? "favorites"
									: "other"
						}
						onChange={(e) =>
							setDraft({
								...draft,
								favorite:
									e.target.value === "all"
										? undefined
										: e.target.value === "favorites",
							})
						}
					>
						<option value="all">ライブラリ</option>
						<option value="favorites">お気に入り</option>
						<option value="other">お気に入り以外</option>
					</select>
				</label>
				<label>
					並び順
					<select
						value={draft.sort === "relevance" ? "relevance" : draft.order}
						onChange={(e) =>
							setDraft({
								...draft,
								sort:
									e.target.value === "relevance" ? "relevance" : "createdAt",
								order: e.target.value === "asc" ? "asc" : "desc",
							})
						}
					>
						<option value="desc">新しい順</option>
						<option value="asc">古い順</option>
						<option value="relevance">一致度順</option>
					</select>
				</label>
				<details open={compact ? undefined : true}>
					<summary>
						タグで絞り込む{draft.tags.length ? `（${draft.tags.length}）` : ""}
					</summary>
					<fieldset>
						<legend>タグ（すべて一致）</legend>
						<small>件数はライブラリ全体の曲数です。</small>
						<div className="music-library-tags">
							{tags.map((t) => (
								<label key={t.tag}>
									<input
										type="checkbox"
										checked={draft.tags.includes(t.tag)}
										onChange={(e) =>
											setDraft({
												...draft,
												tags: e.target.checked
													? [...draft.tags, t.tag]
													: draft.tags.filter((tag) => tag !== t.tag),
											})
										}
									/>
									{t.tag} ({t.count})
								</label>
							))}
						</div>
					</fieldset>
				</details>
				<Button type="submit">検索する</Button>
				<Button type="button" onClick={onRefresh} disabled={loading}>
					更新
				</Button>
			</form>
			{loading && <output aria-live="polite">楽曲を取得中です。</output>}
			{error && (
				<div role="alert">
					<p>{error}</p>
					<Button onClick={onRefresh}>再試行</Button>
				</div>
			)}
			{!loading && !error && total !== undefined && <p>{total}曲</p>}
			{hasMore && (
				<Button onClick={onMore} disabled={loading}>
					次の曲を取得
				</Button>
			)}
		</section>
	);
}
