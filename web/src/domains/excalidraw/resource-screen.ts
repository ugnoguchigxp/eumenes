import { useEffect, useRef } from "react";
import { formatResourceUri } from "../../../../api/domains/resources/contracts";
import { focusWhenDrawn } from "../../components/domains/resource-focus";
import {
	createLiveScreen,
	type WebArtifactAdapter,
} from "../toolchain-artifacts/registry";

/** The adapter ref the drawing resource names (`api/domains/excalidraw/service/resource-adapter.ts`). */
export const DRAWING_ADAPTER_REF = "adapter:excalidraw@1";
/** The id of the one drawing tab (`useOpenDrawing`). */
export const DRAWING_TAB_ID = "drawing-workspace";

/** What the mounted drawing screen holds, read through the latest render. */
export type DrawingScreen = {
	/** The saved drawings the screen lists. */
	referenceIds: ReadonlySet<string>;
	/** The saved drawing the editor is opened on; undefined for a new, unsaved one. */
	shownReferenceId: string | undefined;
	/** The editor is starting or an operation is running: it takes no new open. */
	busy: boolean;
	/** Opens the saved drawing in the editor; false when it could not be connected. */
	open(referenceId: string): Promise<boolean>;
};
const live = createLiveScreen<{ read(): DrawingScreen }>();

/** The mounted drawing screen reports what it holds; the removal runs on unmount. */
export function useLiveDrawingScreen(screen: DrawingScreen) {
	const latest = useRef(screen);
	useEffect(() => {
		latest.current = screen;
	});
	useEffect(() => live.attach({ read: () => latest.current }), []);
}

/**
 * The drawing screen is an OpenUI tab, not a registered artifact; this is its part of the web
 * adapter contract (`focus`, `viewing`). The launcher opens the tab, then `focus` opens the drawing.
 */
export const drawingScreen: Pick<WebArtifactAdapter, "focus" | "viewing"> = {
	async focus(referenceId) {
		const known = await live.waitFor((handle) =>
			handle.read().referenceIds.has(referenceId),
		);
		if (!known) return false;
		if (live.current()?.read().shownReferenceId !== referenceId) {
			const idle = await live.waitFor((handle) => !handle.read().busy);
			if (!idle) return false;
			if (!(await live.current()?.read().open(referenceId))) return false;
			const opened = await live.waitFor(
				(handle) => handle.read().shownReferenceId === referenceId,
			);
			if (!opened) return false;
		}
		// The drawing is open; marking the editor is best effort while the screen draws it.
		await focusWhenDrawn(() =>
			document.querySelector<HTMLElement>(".drawing-artifact"),
		);
		return true;
	},
	viewing() {
		const referenceId = live.current()?.read().shownReferenceId;
		return referenceId ? formatResourceUri("drawing", referenceId) : null;
	},
};
