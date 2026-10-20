import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ArtifactRenderer } from "@eumenes/artifact-ui";
import type {
	BrowserWorkspaceResource,
	Receipt,
} from "@eumenes/artifact-ui/contracts";
import "@eumenes/design-system/styles";
import { ArtifactPanel } from "../../web/src/components/domains/artifact/ArtifactPanel";
import {
	sampleTasks,
	sampleTabs,
	sampleCaptures,
} from "../../packages/design-system/src/components/BrowserWorkspace/fixtures";

// Fixed display data only. No backend, browser connection, credential or media request.
const initial: BrowserWorkspaceResource = {
	kind: "browser",
	revision: 1,
	availability: { available: true },
	connection: { state: "connected" },
	executablePath:
		"/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
	tabs: sampleTabs,
	tasks: sampleTasks,
	captures: sampleCaptures,
	bridge: { revision: 1, enabled: true, configured: true, available: true },
};
declare global {
	interface Window {
		browserFixture: { update: () => void; actions: string[] };
	}
}
window.browserFixture = { update() {}, actions: [] };
function Fixture() {
	const [active, setActive] = useState("browser");
	const [data, setData] = useState(initial);
	useEffect(() => {
		window.browserFixture.update = () =>
			setData({
				...initial,
				revision: 2,
				tasks: initial.tasks.map((t) => ({
					...t,
					state: "indeterminate",
					errorLabel: "接続が切れたため結果を確認できません",
				})),
			});
	}, []);
	const tabs = [
		{
			id: "browser",
			kind: "toolchain" as const,
			title: "ブラウザ",
			artifactRevisionId: "artifact:browser.workspace@4",
		},
		{
			id: "settings",
			kind: "toolchain" as const,
			title: "ブラウザの設定",
			artifactRevisionId: "artifact:settings.browser@1",
		},
	];
	async function dispatch(e: { action: string }): Promise<Receipt> {
		window.browserFixture.actions.push(e.action);
		if (e.action === "browser-settings") setActive("settings");
		if (e.action === "browser-open-workspace") setActive("browser");
		return { status: "accepted", message: "設定を保存しました" };
	}
	return (
		<ArtifactPanel
			tabs={tabs}
			activeTabId={active}
			onSelect={setActive}
			onClose={() => {}}
			renderToolchain={(tab) => (
				<ArtifactRenderer
					definition={JSON.stringify({
						view:
							tab.id === "settings" ? "browser-settings" : "browser-workspace",
						source: "browser",
						title: tab.title,
					})}
					runtime={{ snapshot: { browser: data }, dispatch }}
				/>
			)}
		/>
	);
}
createRoot(document.getElementById("root")!).render(<Fixture />);
