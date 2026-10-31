import { createRoot } from "react-dom/client";
import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ConversationComposer } from "../../../web/src/workspace/ConversationComposer";
import type { WorkspaceState } from "../../../web/src/workspace/useWorkspace";
import { LiveVoicePanel } from "../../../web/src/domains/live-voice/LiveVoicePanel";
import { createAudioStore } from "../../../web/src/domains/audio/store";
import type { useLiveVoice } from "../../../web/src/domains/live-voice/useLiveVoice";
import { settingsFixture } from "../../../web/src/domains/settings/sections/fixture";
import { ToolchainArtifactHost } from "../../../web/src/domains/toolchain-artifacts/ToolchainArtifactHost";
import { settingsWebAdapter } from "../../../web/src/domains/settings-data/adapter";
import { createWebAdapterRegistry } from "../../../web/src/domains/toolchain-artifacts/registry";
import type { EumenesClient } from "../../../client";
import bundle from "../../../api/domains/capabilities/bundles/settings.live.bundle.json";
import existing from "../../../api/domains/capabilities/bundles/settings.bundle.json";
import type { ArtifactDefinitionV1 } from "../../../api/domains/capabilities/contracts";
import "@eumenes/design-system/styles";
import "../../../web/src/app.css";

const artifact = bundle.artifacts[0] as ArtifactDefinitionV1;
const revision = `artifact:settings.live@${artifact.revision}`;
const keys = existing.artifacts.find(
	(a) => a.id === "settings.ai-connections",
)!;
const settings = settingsFixture();
settings.general.agentName = "光";
const client = {
	identity: "live-browser-fixture",
	settings: async () => settings,
	liveCurrent: async () => null,
	toolchainArtifacts: async () => [
		{
			artifactRevisionId: `artifact:${keys.id}@${keys.revision}`,
			title: keys.title,
			launcher: keys.launcher,
			adapterRef: "adapter:settings@1",
		},
		{
			artifactRevisionId: revision,
			title: artifact.title,
			launcher: artifact.launcher,
			adapterRef: "adapter:settings@1",
		},
	],
	toolchainArtifact: async () => ({
		artifact,
		artifactRevisionId: revision,
		digest: "fixture",
		scopeRef: "scope:main",
	}),
	toolchainArtifactSource: async () => ({
		revision: 1,
		data: { options: [], targets: [] },
	}),
	toolchainInteractions: async () => [],
	unsettledToolchainActions: async () => [],
} as unknown as EumenesClient;
const adapters = createWebAdapterRegistry([settingsWebAdapter]);
const cache = new QueryClient({
	defaultOptions: { queries: { retry: false } },
});
const store = createAudioStore();
function Fixture() {
	const [active, setActive] = useState(false);
	const [open, setOpen] = useState(false);
	const [muted, setMuted] = useState(false);
	const [displayed, setDisplayed] = useState(false);
	const live = {
		active,
		busy: false,
		error: null,
		playing: false,
		start: async () => setActive(true),
		stop: async () => setActive(false),
		mute: async () => setMuted(!muted),
		displayed: async () => setDisplayed(true),
		session: active
			? {
					id: "fixture",
					status: "active",
					test: false,
					muted,
					segments: [
						{
							id: "u",
							speaker: "user",
							text: "  はい、はい  ",
							messageId: null,
						},
						{
							id: "a",
							speaker: "assistant",
							text: "お聞きしています。",
							messageId: null,
						},
					],
					notices: [
						{
							id: "confirmation:fixture",
							kind: "confirmation",
							text: "確認する内容をそのまま表示します。",
							displayed,
						},
					],
				}
			: null,
	} as ReturnType<typeof useLiveVoice>;
	const state = {
		live,
		openLiveSettings: () => setOpen(true),
		settings: { data: { live: { enabled: true, model: "fixture-voice" } } },
		voice: { active: false },
		phase: "idle",
		attachments: { items: [], busy: false },
		status: {},
		specialist: { addressee: { kind: "normal", label: "会話" } },
		mute: { muted: false, ready: true, busy: false },
		draft: "",
		submit: { isPending: false },
		edit: { editing: null, target: null },
		stewardActivity: {},
	} as unknown as WorkspaceState;
	return (
		<QueryClientProvider client={cache}>
			<main style={{ maxWidth: 1100, margin: "auto", padding: 12 }}>
				<h1>音声会話 UI fixture</h1>
				<LiveVoicePanel live={live} agentName={settings.general.agentName} />
				<ConversationComposer state={state} store={store} />
				{open && (
					<ToolchainArtifactHost
						client={client}
						adapters={adapters}
						artifactId="live-settings"
						artifactRevisionId={revision}
						visible
					/>
				)}
			</main>
		</QueryClientProvider>
	);
}
createRoot(document.getElementById("root")!).render(<Fixture />);
