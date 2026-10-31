import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { EumenesClient } from "../../../../client";
import type { ArtifactDefinitionV1 } from "../../../../api/domains/capabilities/contracts";
import bundle from "../../../../api/domains/capabilities/bundles/settings.live.bundle.json";
import { settingsFixture } from "../settings/sections/fixture";
import { ToolchainArtifactHost } from "../toolchain-artifacts/ToolchainArtifactHost";
import { createWebAdapterRegistry } from "../toolchain-artifacts/registry";
import { settingsWebAdapter } from "./adapter";
afterEach(cleanup);
test("the persistent save bar applies API-provided model and registered voice selections through the common draft", async () => {
	const artifact = bundle.artifacts[0] as ArtifactDefinitionV1;
	const revision = `artifact:${artifact.id}@${artifact.revision}`;
	const saved = settingsFixture();
	const connectionId = crypto.randomUUID();
	saved.connections = [
		{
			id: connectionId,
			name: "Fixture API",
			baseUrl: "https://api.openai.com/v1",
			enabled: true,
			epoch: 0,
			envRef: null,
		},
	];
	saved.live = {
		...saved.live,
		enabled: true,
		cloudAllowed: true,
		connectionId,
	};
	const submit = vi.fn(async (event: { eventId: string; input: unknown }) => ({
		httpStatus: 200,
		view: {
			eventId: event.eventId,
			status: "accepted",
			createdAt: new Date().toISOString(),
			result: {
				version: 1,
				executionId: "fixture",
				artifactRevisionId: revision,
				outcome: "completed",
				resultRefs: [],
				artifactRefs: [],
			},
		},
	}));
	const models = vi.fn(async () => ({
		models: ["fixture-live-a", "fixture-live-b"],
	}));
	const client = {
		identity: crypto.randomUUID(),
		settings: async () => saved,
		liveCurrent: async () => null,
		liveModels: models,
		toolchainArtifacts: async () => [
			{
				artifactRevisionId: revision,
				title: artifact.title,
				adapterRef: "adapter:settings@1",
				launcher: artifact.launcher,
			},
		],
		toolchainArtifact: async () => ({
			artifact,
			artifactRevisionId: revision,
			digest: "fixture",
			scopeRef: "scope:main",
		}),
		toolchainArtifactSource: async () => ({
			revision: saved.revision,
			data: {
				options: [{ value: connectionId, label: "Fixture API" }],
				targets: [],
			},
		}),
		toolchainInteractions: async () => [],
		unsettledToolchainActions: async () => [],
		submitToolchainAction: submit,
	} as unknown as EumenesClient;
	render(
		<QueryClientProvider
			client={
				new QueryClient({ defaultOptions: { queries: { retry: false } } })
			}
		>
			<ToolchainArtifactHost
				client={client}
				adapters={createWebAdapterRegistry([settingsWebAdapter])}
				artifactId="fixture-live"
				artifactRevisionId={revision}
				visible
			/>
		</QueryClientProvider>,
	);
	const bar = await screen.findByRole("region", { name: "設定の保存" });
	expect(
		within(bar).getByRole("button", { name: "設定の変更をすべて保存" }),
	).toHaveProperty("disabled", true);
	expect(models).not.toHaveBeenCalled();
	fireEvent.mouseDown(screen.getByRole("tab", { name: "音声会話" }), {
		button: 0,
		ctrlKey: false,
	});
	const model = screen.getByLabelText("音声会話のモデル") as HTMLSelectElement;
	const voice = screen.getByLabelText("声の指定") as HTMLSelectElement;
	expect(model.tagName).toBe("SELECT");
	expect(voice.tagName).toBe("SELECT");
	expect(voice.options.length).toBe(32);
	fireEvent.click(
		screen.getByRole("button", { name: "接続を確認・モデル一覧を更新" }),
	);
	await waitFor(() =>
		expect([...model.options].some((o) => o.value === "fixture-live-a")).toBe(
			true,
		),
	);
	fireEvent.change(model, { target: { value: "fixture-live-b" } });
	fireEvent.change(voice, { target: { value: "cedar" } });
	const save = within(bar).getByRole("button", {
		name: "設定の変更をすべて保存",
	});
	await waitFor(() => expect(save).toHaveProperty("disabled", false));
	fireEvent.click(save);
	await waitFor(() => expect(submit).toHaveBeenCalledOnce());
	expect(submit.mock.calls[0]![0].input).toMatchObject({
		changes: expect.arrayContaining([
			{ fieldId: "live.model", value: "fixture-live-b" },
			{ fieldId: "live.voice", value: "cedar" },
		]),
	});
	expect(screen.getByLabelText("話し方の補足").tagName).toBe("TEXTAREA");
});
