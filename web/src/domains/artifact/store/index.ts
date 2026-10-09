export type ArtifactTab =
	| { id: string; title: string; kind: "markdown" | "showcase"; content: string }
	| { id: string; kind: "timer"; title: string; timerId: string };

export type ArtifactWorkspaceState = {
	tabs: ArtifactTab[];
	activeTabId: string | null;
};

export type ArtifactAction =
	| { type: "open"; tab: ArtifactTab }
	| { type: "select"; tabId: string }
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
