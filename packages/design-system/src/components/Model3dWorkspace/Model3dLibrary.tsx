import { useId, useState, type ReactNode } from "react";
import { Button } from "../Button";
import { Input } from "../Input";
import type { Model3dAssetItem, Model3dFilter } from "./types";

export function parseTags(text: string): string[] {
	return [
		...new Set(
			text
				.split(/[,、，]/)
				.map((tag) => tag.trim())
				.filter(Boolean),
		),
	];
}

const sortOptions = [
	{ value: "desc", label: "新しい順" },
	{ value: "asc", label: "古い順" },
	{ value: "relevance", label: "一致度順" },
] as const;

const draftOf = (filter: Model3dFilter) => ({
	q: filter.q,
	tags: filter.tags.join("、"),
	sort: filter.sort,
	order: filter.order,
});

export type Model3dLibraryProps = {
	assets: readonly Model3dAssetItem[];
	selectedId?: string;
	total?: number;
	hasMore: boolean;
	loading?: boolean;
	error?: string;
	filter: Model3dFilter;
	onSearch: (filter: Model3dFilter) => void;
	onSelect: (id: string) => void;
	onMore: () => void;
	onRefresh: () => void;
	renderThumbnail?: (assetId: string) => ReactNode;
};

/** Search, result list and paging. The host owns the cursor and discards it on a new search. */
export function Model3dLibrary({
	assets,
	selectedId,
	total,
	hasMore,
	loading,
	error,
	filter,
	onSearch,
	onSelect,
	onMore,
	onRefresh,
	renderThumbnail,
}: Model3dLibraryProps) {
	const id = useId();
	const applied = JSON.stringify(filter);
	const [draft, setDraft] = useState(() => draftOf(filter));
	// The draft follows the search the host applied (e.g. one asked for from the conversation).
	const [seen, setSeen] = useState(applied);
	if (seen !== applied) {
		setSeen(applied);
		setDraft(draftOf(filter));
	}
	return (
		<section className="model3d-library" aria-label="3Dモデルの一覧">
			<form
				className="model3d-search"
				role="search"
				aria-label="3Dモデルを探す"
				onSubmit={(event) => {
					event.preventDefault();
					onSearch({
						q: draft.q.trim(),
						tags: parseTags(draft.tags),
						sort: draft.sort,
						order: draft.order,
					});
				}}
			>
				<div className="model3d-search-row">
					<label className="model3d-field-label" htmlFor={`${id}-q`}>
						検索
					</label>
					<Input
						id={`${id}-q`}
						value={draft.q}
						maxLength={200}
						placeholder="タイトル・元の文章・タグ"
						onChange={(event) => setDraft({ ...draft, q: event.target.value })}
					/>
					<Button type="submit" disabled={loading}>
						検索する
					</Button>
					<Button
						type="button"
						variant="outline"
						disabled={loading}
						onClick={onRefresh}
					>
						更新
					</Button>
				</div>
				<div className="model3d-search-row">
					<label className="model3d-field-label" htmlFor={`${id}-tags`}>
						タグ（すべて一致）
					</label>
					<Input
						id={`${id}-tags`}
						value={draft.tags}
						maxLength={240}
						onChange={(event) =>
							setDraft({ ...draft, tags: event.target.value })
						}
					/>
					<label>
						<span className="model3d-field-label">並び順</span>
						<select
							value={draft.sort === "relevance" ? "relevance" : draft.order}
							onChange={(event) =>
								setDraft({
									...draft,
									sort:
										event.target.value === "relevance"
											? "relevance"
											: "createdAt",
									order: event.target.value === "asc" ? "asc" : "desc",
								})
							}
						>
							{sortOptions.map((option) => (
								<option key={option.value} value={option.value}>
									{option.label}
								</option>
							))}
						</select>
					</label>
				</div>
			</form>
			{loading && <output aria-live="polite">3Dモデルを取得中です。</output>}
			{error && (
				<div role="alert">
					<p>{error}</p>
					<Button type="button" variant="outline" onClick={onRefresh}>
						再試行
					</Button>
				</div>
			)}
			{!loading && !error && total !== undefined && <p>{total}件</p>}
			{!loading && !error && assets.length === 0 && (
				<p>該当する3Dモデルはありません。</p>
			)}
			<ul className="model3d-results">
				{assets.map((asset) => (
					<li key={asset.id} data-selected={asset.id === selectedId}>
						<div className="model3d-result">
							<div className="model3d-result-preview">
								{renderThumbnail ? (
									renderThumbnail(asset.id)
								) : asset.thumbnailUrl ? (
									<img src={asset.thumbnailUrl} alt="" loading="lazy" />
								) : (
									<span className="model3d-thumb-empty" aria-hidden="true" />
								)}
							</div>
							<button
								type="button"
								className="model3d-result-open"
								aria-label={`${asset.title}を開く`}
								aria-pressed={asset.id === selectedId}
								onClick={() => onSelect(asset.id)}
							>
								<span className="model3d-result-text">
									<strong>{asset.title}</strong>
									<time dateTime={asset.createdAt}>
										{new Date(asset.createdAt).toLocaleDateString("ja-JP")}
									</time>
									{asset.tags.length > 0 && (
										<small>{asset.tags.join("・")}</small>
									)}
									{asset.warnings.length > 0 && (
										<small className="model3d-warn-flag">
											注意 {asset.warnings.length}件
										</small>
									)}
								</span>
							</button>
						</div>
					</li>
				))}
			</ul>
			{hasMore && (
				<Button
					type="button"
					variant="outline"
					disabled={loading}
					onClick={onMore}
				>
					さらに表示
				</Button>
			)}
		</section>
	);
}
