import { useState } from "react";
import { createRoot } from "react-dom/client";
import {
	Model3dWorkspace,
	ImageGallery,
	type Model3dAssetItem,
	type Model3dGenerateValues,
} from "@eumenes/design-system";
import "@eumenes/design-system/styles";
import { BoxGeometry, Mesh, MeshStandardMaterial } from "three";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { ResizableWorkspace } from "../../web/src/components/domains/artifact/ResizableWorkspace";
import { Model3dThumbnail } from "../../web/src/domains/model3d/Model3dThumbnail";
import { Model3dViewer } from "../../web/src/domains/model3d/Model3dViewer";
import type { Model3dApi } from "../../web/src/domains/model3d/api";

declare global {
	interface Window {
		model3dTest: {
			loads: number;
			active: number;
			peak: number;
			submitted: Model3dGenerateValues[];
		};
	}
}
window.model3dTest = { loads: 0, active: 0, peak: 0, submitted: [] };
const mesh = new Mesh(
	new BoxGeometry(),
	new MeshStandardMaterial({ color: 0x36a5a4 }),
);
const bytes = new GLTFExporter().parseAsync(mesh, { binary: true });
const api = {
	async assetContent(_id: string, signal?: AbortSignal) {
		const stats = window.model3dTest;
		stats.loads++;
		stats.active++;
		stats.peak = Math.max(stats.peak, stats.active);
		try {
			const result = await bytes;
			signal?.throwIfAborted();
			if (!(result instanceof ArrayBuffer))
				throw new Error("invalid_fixture_glb");
			return result;
		} finally {
			stats.active--;
		}
	},
} as Model3dApi;
const items: Model3dAssetItem[] = Array.from({ length: 18 }, (_, index) => ({
	id: `model-${index + 1}`,
	title: `モデル${index + 1}`,
	tags: ["試作"],
	createdAt: "2026-10-18T00:00:00Z",
	prompt: "青緑の立体",
	warnings: [],
}));
const sourceImages = Array.from({ length: 9 }, (_, index) => ({
	id: `image-${index}`,
	title: `保存画像${index + 1}`,
	thumbnailUrl: `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="hsl(${index * 35} 30% 45%)"/><circle cx="128" cy="128" r="75" fill="white"/></svg>`)}`,
}));

function Fixture() {
	const [selected, setSelected] = useState<Model3dAssetItem>();
	return (
		<ResizableWorkspace
			artifact={
				<aside className="artifact-panel">
					<header className="artifact-panel-header">3Dモデル ×</header>
					<div className="artifact-panel-body">
						<Model3dWorkspace
							available
							generations={[]}
							sourceImages={sourceImages}
							onUploadImage={
								document.body.dataset.fixture === "upload"
									? async () => ({
											status: "succeeded",
											image: {
												id: "image_uploaded",
												title: "取り込んだ画像",
												thumbnailUrl: sourceImages[0]!.thumbnailUrl,
											},
										})
									: undefined
							}
							assets={items}
							selectedAsset={selected}
							total={items.length}
							hasMore={false}
							filter={{ q: "", tags: [], sort: "createdAt", order: "desc" }}
							renderThumbnail={(id) => (
								<Model3dThumbnail assetId={id} api={api} />
							)}
							renderViewer={(id) => <Model3dViewer assetId={id} api={api} />}
							onGenerate={(value) => {
								window.model3dTest.submitted.push(value);
								return true;
							}}
							onSelect={(id) =>
								setSelected(items.find((item) => item.id === id))
							}
							onCancel={() => {}}
							onRecheck={() => {}}
							onDelete={() => setSelected(undefined)}
							onUpdate={() => {}}
							onSearch={() => {}}
							onMore={() => {}}
							onRefresh={() => {}}
						/>
					</div>
				</aside>
			}
		>
			<section className="chat-panel">
				<h2>会話</h2>
				<p>アーティファクトと並べて表示</p>
			</section>
		</ResizableWorkspace>
	);
}
createRoot(document.getElementById("root")!).render(
	document.body.dataset.fixture === "gallery" ? (
		<ImageGallery
			images={[
				{
					id: "saved",
					title: "保存画像",
					url: sourceImages[0]!.thumbnailUrl,
					width: 256,
					height: 256,
					createdAt: "2026-10-18T00:00:00Z",
					format: "png",
				},
			]}
			onRefresh={() => {}}
			onSelect={() => {}}
			onDelete={() => {}}
		/>
	) : (
		<Fixture />
	),
);
