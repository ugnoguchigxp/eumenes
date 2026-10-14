import { useEffect } from "react";
import "./asset-path";
import { Excalidraw, serializeAsJSON } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import { DrawingEditorFrame } from "@eumenes/design-system";
import type { EumenesClient } from "../../../../client";
import type { Scene } from "../../../../api/domains/excalidraw/contracts";
import { useDrawingEditor } from "./useDrawingEditor";
import { useDrawingBridge } from "./useDrawingBridge";
import "./drawing-editor.css";
export default function DrawingEditor({
	client,
	referenceId,
	revision,
	conversationId = "main",
	embedded = false,
}: {
	client: EumenesClient;
	referenceId: string;
	revision?: number;
	conversationId?: string;
	embedded?: boolean;
}) {
	const e = useDrawingEditor(client, referenceId, revision, conversationId);
	useDrawingBridge(embedded, referenceId, e);
	const activity = e.activity;
	useEffect(() => {
		const operation = (event: Event) => {
			// Frame commands already own their connection operation; only canvas gestures renew here.
			if (
				event.target instanceof Element &&
				event.target.closest(".excalidraw")
			)
				void activity();
		};
		const events = ["pointerdown", "keydown", "wheel"] as const;
		for (const event of events)
			window.addEventListener(event, operation, { passive: true });
		return () => {
			for (const event of events) window.removeEventListener(event, operation);
		};
	}, [activity]);
	const canvas = (
		<div
			role="application"
			aria-label="Excalidraw"
			className={embedded ? "drawing-embedded" : undefined}
		>
			{!embedded && (
				<DrawingEditorFrame
					title={e.title}
					status={e.status}
					error={e.error}
					busy={e.busy}
					hasDraft={e.hasDraft}
					onTitle={e.changeTitle}
					onSave={() => void e.save()}
					onReconnect={() => void e.reconnect()}
					onRestore={e.restore}
					onDownload={e.download}
					onClose={() => void e.close()}
				>
					{renderCanvas()}
				</DrawingEditorFrame>
			)}
			{embedded && renderCanvas()}
		</div>
	);
	function renderCanvas() {
		return e.drawing ? (
			<Excalidraw
				key={e.canvasEpoch}
				initialData={
					{ ...e.drawing.scene, scrollToContent: true } as Parameters<
						typeof Excalidraw
					>[0]["initialData"]
				}
				langCode="ja-JP"
				theme={
					window.matchMedia("(prefers-color-scheme: dark)").matches
						? "dark"
						: "light"
				}
				onChange={(elements, appState, files) => {
					const data = JSON.parse(
						serializeAsJSON(elements, appState, files, "database"),
					);
					const scene: Scene = {
						elements: data.elements,
						appState: {
							viewBackgroundColor: data.appState.viewBackgroundColor,
						},
						files,
					};
					e.changeScene(scene);
				}}
				UIOptions={{
					canvasActions: { loadScene: false, saveToActiveFile: false },
				}}
			/>
		) : (
			<output className="drawing-loading">{e.error || e.status}</output>
		);
	}
	return canvas;
}
