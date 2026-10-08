import { useCallback, useReducer } from "react";
import {
	type ArtifactTab,
	emptyArtifactWorkspace,
	reduceArtifactWorkspace,
} from "../store";

export function useArtifactWorkspace() {
	const [state, dispatch] = useReducer(
		reduceArtifactWorkspace,
		undefined,
		emptyArtifactWorkspace,
	);
	return {
		...state,
		active: state.tabs.find((tab) => tab.id === state.activeTabId) ?? null,
		open: useCallback(
			(tab: ArtifactTab) => dispatch({ type: "open", tab }),
			[],
		),
		select: useCallback(
			(tabId: string) => dispatch({ type: "select", tabId }),
			[],
		),
		close: useCallback(
			(tabId: string) => dispatch({ type: "close", tabId }),
			[],
		),
		closeAll: useCallback(() => dispatch({ type: "close-all" }), []),
	};
}
