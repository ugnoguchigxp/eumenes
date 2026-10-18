import { useLayoutEffect, useRef, useState } from "react";
import { Button } from "../Button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../Tabs";
import { Model3dDetail } from "./Model3dDetail";
import { Model3dGenerationForm } from "./Model3dGenerationForm";
import { Model3dGenerationList } from "./Model3dGenerationList";
import { Model3dLibrary } from "./Model3dLibrary";
import type { Model3dWorkspaceProps } from "./types";
import "./Model3dWorkspace.css";

export type { Model3dWorkspaceProps } from "./types";
type Tab = "create" | "library";

/** The nearest scrolling owner may be either a side-by-side or a stacked artifact. */
function scrollOwner(node: HTMLElement | null) {
	for (let owner = node?.parentElement; owner; owner = owner.parentElement) {
		if (/(auto|scroll)/.test(getComputedStyle(owner).overflowY)) return owner;
	}
	return null;
}

/** Props only: the host supplies data, the renderer and every approved operation. */
export function Model3dWorkspace(props: Model3dWorkspaceProps) {
	const selected = props.selectedAsset;
	const assetId = selected?.id;
	const generationId = props.highlightedGenerationId;
	const focusSequence = props.focus?.seq;
	const focusKind = props.focus?.kind;
	const [tab, setTab] = useState<Tab>(
		focusKind === "generation"
			? "create"
			: assetId || focusKind === "search"
				? "library"
				: "create",
	);
	const [detailId, setDetailId] = useState(
		focusKind === "search" ? undefined : assetId,
	);
	const root = useRef<HTMLElement>(null);
	const location = useRef<
		{ owner: HTMLElement; top: number; focus: HTMLElement | null } | undefined
	>(undefined);
	const appliedSearch = useRef<number | undefined>(undefined);
	const [seen, setSeen] = useState({ assetId, generationId, focusSequence });
	if (
		seen.assetId !== assetId ||
		seen.generationId !== generationId ||
		seen.focusSequence !== focusSequence
	) {
		setSeen({ assetId, generationId, focusSequence });
		if (focusSequence !== seen.focusSequence && focusKind === "search") {
			setTab("library");
			setDetailId(undefined);
		} else if (
			focusSequence !== seen.focusSequence &&
			focusKind === "generation"
		) {
			setTab("create");
		} else if (
			assetId &&
			(assetId !== seen.assetId ||
				(focusKind === "asset" && focusSequence !== seen.focusSequence))
		) {
			setTab("library");
			setDetailId(assetId);
		} else if (generationId && generationId !== seen.generationId)
			setTab("create");
		if (!assetId && seen.assetId) setDetailId(undefined);
	}
	useLayoutEffect(() => {
		if (tab !== "library") return;
		if (focusKind === "search" && appliedSearch.current !== focusSequence) {
			appliedSearch.current = focusSequence;
			location.current = undefined;
			const owner = scrollOwner(root.current);
			if (owner) owner.scrollTop = 0;
			return;
		}
		if (detailId) {
			const owner = scrollOwner(root.current);
			if (owner) owner.scrollTop = 0;
		} else if (location.current) {
			const saved = location.current;
			saved.focus?.focus({ preventScroll: true });
			saved.owner.scrollTop = saved.top;
		}
	}, [detailId, tab, focusSequence, focusKind]);
	function open(id: string) {
		const owner = scrollOwner(root.current);
		if (owner)
			location.current = {
				owner,
				top: owner.scrollTop,
				focus:
					document.activeElement instanceof HTMLElement
						? document.activeElement
						: null,
			};
		setDetailId(id);
		setTab("library");
		props.onSelect(id);
	}
	return (
		<section ref={root} className="model3d-workspace" aria-label="3Dモデル">
			<Tabs value={tab} onValueChange={(value) => setTab(value as Tab)}>
				<TabsList>
					<TabsTrigger value="create">作る</TabsTrigger>
					<TabsTrigger value="library">ライブラリ</TabsTrigger>
				</TabsList>
				<TabsContent
					value="create"
					forceMount
					hidden={tab !== "create"}
					className="model3d-pane"
				>
					<Model3dGenerationForm
						available={props.available}
						unavailableReason={props.unavailableReason}
						sourceImages={props.sourceImages}
						sourceImagesLoading={props.sourceImagesLoading}
						sourceImagesError={props.sourceImagesError}
						onRefreshImages={props.onRefresh}
						pending={props.pending}
						onGenerate={props.onGenerate}
					/>
					<Model3dGenerationList
						generations={props.generations}
						highlightedId={props.highlightedGenerationId}
						pending={props.pending}
						onCancel={props.onCancel}
						onRecheck={props.onRecheck}
						onSelect={open}
					/>
				</TabsContent>
				<TabsContent
					value="library"
					forceMount
					hidden={tab !== "library"}
					className="model3d-pane"
				>
					<div hidden={!!detailId}>
						<Model3dLibrary
							assets={props.assets}
							selectedId={assetId}
							total={props.total}
							hasMore={props.hasMore}
							loading={props.loading}
							error={props.error}
							filter={props.filter}
							onSearch={props.onSearch}
							onSelect={open}
							onMore={props.onMore}
							onRefresh={props.onRefresh}
							renderThumbnail={
								tab === "library" && !detailId
									? props.renderThumbnail
									: undefined
							}
						/>
					</div>
					{detailId && (
						<section className="model3d-focus" aria-label="モデルの拡大詳細">
							<Button
								type="button"
								variant="ghost"
								onClick={() => setDetailId(undefined)}
							>
								一覧に戻る
							</Button>
							{selected?.id === detailId ? (
								<Model3dDetail
									asset={selected}
									viewer={
										tab === "library"
											? props.renderViewer?.(selected.id)
											: undefined
									}
									pending={props.pending}
									onUpdate={props.onUpdate}
									onDelete={props.onDelete}
								/>
							) : (
								<output>3Dモデルの詳細を読み込んでいます。</output>
							)}
						</section>
					)}
				</TabsContent>
			</Tabs>
			{props.message && (
				<output className="model3d-feedback" aria-live="polite">
					{props.message}
				</output>
			)}
		</section>
	);
}
