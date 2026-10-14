import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { MusicRecord } from "../../../api/domains/music/contracts";
import { useArtifactWorkspace } from "../domains/artifact";
import { MusicResultLink } from "../domains/music/MusicResultLink";
import { MUSIC_SCREEN_ADAPTER_REF } from "../domains/music/toolchain-adapter";
import { useToolchainArtifacts } from "../domains/toolchain-artifacts";

afterEach(cleanup);

test("a completed chat result opens the registered screen at its saved track", async () => {
	const client = {
		identity: "local-test",
		toolchainArtifacts: vi.fn(async () => [
			{
				artifactRevisionId: "artifact:music.generation@1",
				title: "楽曲生成",
				adapterRef: MUSIC_SCREEN_ADAPTER_REF,
			},
		]),
	};
	const item: MusicRecord = {
		id: "chosen",
		runId: "run-chosen",
		conversationId: "main",
		state: "completed",
		title: "休日の曲",
		description: "",
		prompt: null,
		durationSeconds: 30,
		phase: "completed",
		jobId: null,
		errorCode: null,
		mime: "audio/ogg",
		actualModel: null,
		createdAt: 1,
		updatedAt: 1,
	};
	function View() {
		const workspace = useArtifactWorkspace();
		const toolchain = useToolchainArtifacts(client as never, workspace.open);
		return (
			<>
				<MusicResultLink
					runId="run-chosen"
					items={[item]}
					onOpen={(id) =>
						void toolchain.openByAdapter(MUSIC_SCREEN_ADAPTER_REF, id)
					}
				/>
				<output data-testid="target">
					{workspace.active?.kind === "toolchain"
						? workspace.active.targetRef
						: ""}
				</output>
			</>
		);
	}
	const cache = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	render(
		<QueryClientProvider client={cache}>
			<View />
		</QueryClientProvider>,
	);
	await act(async () =>
		fireEvent.click(
			screen.getByRole("button", { name: "アーティファクトで再生する" }),
		),
	);
	await waitFor(() =>
		expect(screen.getByTestId("target").textContent).toBe("chosen"),
	);
});
