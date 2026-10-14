import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { createWebAdapterRegistry } from "../toolchain-artifacts/registry";
import { ToolchainArtifactHost } from "../toolchain-artifacts/ToolchainArtifactHost";
import { musicScreenWebAdapter } from "./toolchain-adapter";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

test("registered music screen creates and cancels through the existing conversation API", async () => {
	const artifact = {
		kind: "artifact",
		id: "music.generation",
		revision: 1,
		title: "楽曲生成",
		defaultVariant: "standard",
		variants: [
			{
				id: "standard",
				label: "標準",
				definition: {
					view: "music-workspace",
					source: "music-studio",
					creationOptions: {
						genreGroups: [{ label: "登録ジャンル", options: ["実験音楽"] }],
						moods: ["穏やか"],
						instruments: ["ピアノ"],
						tempos: ["ゆっくり"],
						durations: [30],
						vocalists: ["おまかせ"],
						ranges: ["おまかせ"],
						voiceQualities: ["柔らかい"],
						singingStyles: ["ソロ"],
						languages: ["日本語"],
						defaults: {
							tempo: "ゆっくり",
							duration: 30,
							vocalist: "おまかせ",
							range: "おまかせ",
							singingStyle: "ソロ",
							language: "日本語",
						},
					},
				},
			},
		],
		sourceBindings: [
			{
				source: "music-studio",
				adapterRef: "adapter:music-screen@1",
				query: "query:music-screen.list@1",
				target: "none",
			},
		],
		actionBindings: ["music-select", "music-generate", "music-cancel"].map(
			(eventAction) => ({
				actionId: eventAction,
				eventAction,
				source: "music-studio",
				inputSchemaRef: "builtin:emptyInput",
				effect: "local",
			}),
		),
	};
	const run = { id: "run-1", status: "queued", revision: 1 };
	const client = {
		identity: crypto.randomUUID(),
		toolchainArtifact: vi.fn(async () => ({
			artifact,
			artifactRevisionId: "artifact:music.generation@1",
			digest: "music",
			scopeRef: "scope:main",
		})),
		unsettledToolchainActions: vi.fn(async () => []),
		submitToolchainAction: vi.fn(async () => {
			throw new Error("generation_must_use_conversation_api");
		}),
		musicList: vi.fn(async () => []),
		musicAudio: vi.fn(),
		submit: vi.fn(
			async (_input: {
				requestId: string;
				conversationId: string;
				text: string;
			}) => ({ ...run }),
		),
		run: vi.fn(async () => ({ ...run })),
		cancel: vi.fn(async () => {
			run.status = "cancelled";
			run.revision++;
			return { ...run };
		}),
	};
	const cache = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	render(
		<QueryClientProvider client={cache}>
			<ToolchainArtifactHost
				client={client as never}
				adapters={createWebAdapterRegistry([musicScreenWebAdapter])}
				artifactRevisionId="artifact:music.generation@1"
				artifactId="music-screen-test"
			/>
		</QueryClientProvider>,
	);
	const prompt = await screen.findByRole("textbox", {
		name: "音楽作成プロンプト",
	});
	expect(screen.getByRole("checkbox", { name: "実験音楽" })).toBeTruthy();
	expect(screen.queryByRole("checkbox", { name: "オーケストラ" })).toBeNull();
	fireEvent.change(prompt, { target: { value: "静かなピアノ曲" } });
	fireEvent.click(screen.getByRole("button", { name: "楽曲を生成" }));
	await waitFor(() => expect(client.submit).toHaveBeenCalledOnce());
	expect(client.submit.mock.calls[0]![0]).toMatchObject({
		conversationId: "main",
		text: expect.stringContaining("静かなピアノ曲"),
	});
	fireEvent.click(
		await screen.findByRole("button", { name: "生成を取り消す" }),
	);
	await waitFor(() => expect(client.cancel).toHaveBeenCalledWith("run-1"));
	expect(client.submitToolchainAction).not.toHaveBeenCalled();
});
