import { useLayoutEffect } from "react";
import type { ScreenObservation } from "../../../../api/domains/dialogue/contracts";

export type PublicScreenState = Pick<
	ScreenObservation,
	"selection" | "activity" | "contentRevision" | "dirty"
>;
type MountedState = Omit<
	ScreenObservation,
	"sessionId" | "sequence" | "observedAt"
> & { adapterRef?: string };
const visibleScreens = new Map<string, MountedState>();

/** Record only the public projection of the committed, visible render. */
export function useScreenObservation(
	tabId: string,
	visible: boolean,
	state: MountedState,
) {
	useLayoutEffect(() => {
		if (!visible) return;
		visibleScreens.set(tabId, state);
		return () => {
			if (visibleScreens.get(tabId) === state) visibleScreens.delete(tabId);
		};
	});
}

export function readScreenState(tabId: string, artifactRevisionId: string) {
	const state = visibleScreens.get(tabId);
	return state?.artifactRevisionId === artifactRevisionId ? state : undefined;
}
