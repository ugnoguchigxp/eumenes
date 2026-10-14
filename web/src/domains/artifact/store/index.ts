export type ArtifactTab =
	| {
			id: string;
			title: string;
			kind: "markdown";
			content: string;
	  }
	| {
			id: string;
			kind: "toolchain";
			title: string;
			artifactRevisionId: string;
			/** Presentation variant of the registered artifact; undefined is its default. */
			variantId?: string;
			/** The saved item the screen shows (host-issued ref, e.g. a timer id). */
			targetRef?: string;
	  }
	| {
			id: string;
			kind: "openui";
			title: string;
			definition: string;
			keepMounted?: boolean;
	  };

export type ArtifactWorkspaceState = {
	tabs: ArtifactTab[];
	activeTabId: string | null;
};

export type ArtifactAction =
	| { type: "open"; tab: ArtifactTab }
	| { type: "select"; tabId: string }
	| { type: "set-target"; tabId: string; targetRef: string | undefined }
	| { type: "close"; tabId: string }
	| { type: "close-all" };

export const maxArtifactTabs = 8;

export const emptyArtifactWorkspace = (): ArtifactWorkspaceState => ({
	tabs: [],
	activeTabId: null,
});

export function reduceArtifactWorkspace(
	state: ArtifactWorkspaceState,
	action: ArtifactAction,
): ArtifactWorkspaceState {
	if (action.type === "close-all") return emptyArtifactWorkspace();
	if (action.type === "open") {
		const exists = state.tabs.some((tab) => tab.id === action.tab.id);
		const merged = exists
			? state.tabs.map((tab) => (tab.id === action.tab.id ? action.tab : tab))
			: [...state.tabs, action.tab];
		const tabs = merged.slice(-maxArtifactTabs);
		return { tabs, activeTabId: action.tab.id };
	}
	if (action.type === "set-target") {
		// A target change comes from inside the screen; it never changes the active tab.
		const current = state.tabs.find((tab) => tab.id === action.tabId);
		if (current?.kind !== "toolchain" || current.targetRef === action.targetRef)
			return state;
		return {
			...state,
			tabs: state.tabs.map((tab) =>
				tab === current ? { ...current, targetRef: action.targetRef } : tab,
			),
		};
	}
	if (action.type === "select") {
		return state.tabs.some((tab) => tab.id === action.tabId)
			? { ...state, activeTabId: action.tabId }
			: state;
	}
	const tabs = state.tabs.filter((tab) => tab.id !== action.tabId);
	if (tabs.length === state.tabs.length) return state;
	return {
		tabs,
		activeTabId:
			state.activeTabId === action.tabId
				? (tabs.at(-1)?.id ?? null)
				: state.activeTabId,
	};
}
