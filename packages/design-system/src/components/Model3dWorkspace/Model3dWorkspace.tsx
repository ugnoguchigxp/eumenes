import { useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../Tabs";
import { Model3dDetail } from "./Model3dDetail";
import { Model3dGenerationForm } from "./Model3dGenerationForm";
import { Model3dGenerationList } from "./Model3dGenerationList";
import { Model3dLibrary } from "./Model3dLibrary";
import type { Model3dWorkspaceProps } from "./types";
import "./Model3dWorkspace.css";

export type { Model3dWorkspaceProps } from "./types";

type Tab = "create" | "library";

/** Props only: the host supplies data, the viewer and every approved operation. */
export function Model3dWorkspace(props: Model3dWorkspaceProps) {
	const selected = props.selectedAsset;
	const assetId = selected?.id;
	const generationId = props.highlightedGenerationId;
	const [tab, setTab] = useState<Tab>(assetId ? "library" : "create");
	// A request from the host to show an asset or a generation moves to the tab that has it.
	const [seen, setSeen] = useState({ assetId, generationId });
	if (seen.assetId !== assetId || seen.generationId !== generationId) {
		setSeen({ assetId, generationId });
		if (assetId && assetId !== seen.assetId) setTab("library");
		else if (generationId && generationId !== seen.generationId)
			setTab("create");
	}
	return (
		<section className="model3d-workspace" aria-label="3Dモデル">
			<Tabs value={tab} onValueChange={(value) => setTab(value as Tab)}>
				<TabsList>
					<TabsTrigger value="create">作る</TabsTrigger>
					<TabsTrigger value="library">ライブラリ</TabsTrigger>
				</TabsList>
				<TabsContent value="create" forceMount className="model3d-pane">
					<Model3dGenerationForm
						available={props.available}
						unavailableReason={props.unavailableReason}
						sourceImages={props.sourceImages}
						sourceImagesLoading={props.sourceImagesLoading}
						pending={props.pending}
						onGenerate={props.onGenerate}
					/>
					<Model3dGenerationList
						generations={props.generations}
						highlightedId={props.highlightedGenerationId}
						pending={props.pending}
						onCancel={props.onCancel}
						onRecheck={props.onRecheck}
						onSelect={(id) => {
							props.onSelect(id);
							setTab("library");
						}}
					/>
				</TabsContent>
				<TabsContent value="library" forceMount className="model3d-pane">
					<Model3dLibrary
						assets={props.assets}
						selectedId={selected?.id}
						total={props.total}
						hasMore={props.hasMore}
						loading={props.loading}
						error={props.error}
						filter={props.filter}
						onSearch={props.onSearch}
						onSelect={props.onSelect}
						onMore={props.onMore}
						onRefresh={props.onRefresh}
					/>
					{selected ? (
						<Model3dDetail
							asset={selected}
							viewer={props.renderViewer?.(selected.id)}
							pending={props.pending}
							onUpdate={props.onUpdate}
							onDelete={props.onDelete}
						/>
					) : (
						<p className="model3d-empty">
							一覧から3Dモデルを選ぶと、ここに表示します。
						</p>
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
