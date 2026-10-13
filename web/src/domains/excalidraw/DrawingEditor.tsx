import { useEffect } from "react";
import "./asset-path";
import { Excalidraw, serializeAsJSON } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import { DrawingEditorFrame } from "@eumenes/design-system";
import type { EumenesClient } from "../../../../client";
import type { Scene } from "../../../../api/domains/excalidraw/contracts";
import { useDrawingEditor } from "./useDrawingEditor";
export default function DrawingEditor({
	client,
	referenceId,
	revision,
	conversationId = "main",
}: {
	client: EumenesClient;
	referenceId: string;
	revision?: number;
	conversationId?: string;
}) {
	const e = useDrawingEditor(client, referenceId, revision, conversationId);
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
	return (
		<div role="application" aria-label="Excalidraw">
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
				{e.drawing && (
					<Excalidraw
						key={e.canvasEpoch}
						initialData={
							{ ...e.drawing.scene, scrollToContent: true } as Parameters<
								typeof Excalidraw
							>[0]["initialData"]
						}
						langCode="ja-JP"
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
				)}
			</DrawingEditorFrame>
		</div>
	);
}
