import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ArtifactPanel } from "../../web/src/components/domains/artifact/ArtifactPanel";
import { ToolchainArtifactHost } from "../../web/src/domains/toolchain-artifacts/ToolchainArtifactHost";
import { createWebAdapterRegistry } from "../../web/src/domains/toolchain-artifacts/registry";
import { musicScreenWebAdapter } from "../../web/src/domains/music/toolchain-adapter";
import { demoAudio } from "../../packages/design-system/src/components/MusicPlayer/demo.fixture";
import "@eumenes/design-system/styles";
import "../../web/src/app.css";
import musicScreenBundle from "../../api/domains/capabilities/bundles/music-screen.bundle.json";

const cache = new QueryClient({
	defaultOptions: { queries: { retry: false } },
});
const key = ["music", "list", "main"];
let item = {
	id: "saved-fixture",
	runId: "saved-run",
	title: "再生確認曲",
	state: "completed",
	description: "ブラウザ内の試験音源",
	createdAt: 1,
	updatedAt: 1,
	mime: "audio/wav",
};
cache.setQueryData(key, [item]);
const client = {
	identity: "music-autoplay-fixture",
	toolchainArtifact: async () => ({
		artifact: musicScreenBundle.artifacts.at(-1)!,
		artifactRevisionId: "artifact:music.generation@3",
		scopeRef: "scope:main",
	}),
	unsettledToolchainActions: async () => [],
	musicList: async () => [item],
	musicProviders: async () => ({ providers: [] }),
	musicAudio: async () => demoAudio(),
	submit: async () => {
		await new Promise((resolve) => setTimeout(resolve, 100));
		item = {
			...item,
			id: "autoplay-fixture",
			runId: "fixture-run",
			state: "generating",
			createdAt: 2,
			updatedAt: 2,
		};
		cache.setQueryData(key, [item]);
		return { id: "fixture-run", status: "running", revision: 1 };
	},
	run: async () => ({
		id: "fixture-run",
		status: item.state === "completed" ? "completed" : "running",
		revision: item.updatedAt,
	}),
};
function Fixture() {
	return (
		<div
			style={{
				display: "grid",
				gridTemplateRows: "auto minmax(0, 1fr)",
				height: "100%",
			}}
		>
			<button
				onClick={() => {
					// Generation completion arrives asynchronously, outside the click gesture.
					setTimeout(() => {
						item = {
							...item,
							state: "completed",
							updatedAt: item.updatedAt + 1,
						};
						cache.setQueryData(key, [item]);
					}, 50);
				}}
			>
				完成通知
			</button>
			<ArtifactPanel
				tabs={[
					{
						id: "music",
						kind: "toolchain",
						title: "音楽生成",
						artifactRevisionId: "artifact:music.generation@3",
					},
				]}
				activeTabId="music"
				onSelect={() => {}}
				onClose={() => {}}
				renderToolchain={() => (
					<ToolchainArtifactHost
						client={client as never}
						adapters={createWebAdapterRegistry([musicScreenWebAdapter])}
						artifactRevisionId="artifact:music.generation@3"
						artifactId="music"
					/>
				)}
			/>
		</div>
	);
}
createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<QueryClientProvider client={cache}>
			<Fixture />
		</QueryClientProvider>
	</StrictMode>,
);
