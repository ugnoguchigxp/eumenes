import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, expect, test, vi } from "vitest";
import type { AdapterHostContext } from "../toolchain-artifacts/registry";
import { codexTasksWebAdapter } from "./toolchain-adapter";

afterEach(cleanup);

type Settings = {
	revision: number;
	enabled: boolean;
	runnerId: string | null;
	workspaceId: string | null;
	resourceId: string | null;
};
const saved: Settings = {
	revision: 7,
	enabled: true,
	runnerId: null,
	workspaceId: null,
	resourceId: "model-a",
};
function setup(
	data: { settings: Settings; resources: { id: string; label: string }[] },
	source = "codex-settings",
) {
	const client = {
		identity: crypto.randomUUID(),
		toolchainArtifactSource: vi.fn(async () => ({
			revision: 3,
			data: { ...data, allowed: { resources: [] } },
		})),
	};
	const cache = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const context = {
		client,
		artifactRevisionId: "artifact:codex@1",
		visible: true,
		artifact: { sourceBindings: [{ source }] },
	} as unknown as AdapterHostContext;
	const hook = renderHook(() => codexTasksWebAdapter.useArtifact(context), {
		wrapper: ({ children }: PropsWithChildren) => (
			<QueryClientProvider client={cache}>{children}</QueryClientProvider>
		),
	});
	return { hook, client, cache };
}

test("the form lists the saved models and defaults to the stored settings", async () => {
	const h = setup({
		settings: saved,
		resources: [
			{ id: "model-a", label: "モデルA" },
			{ id: "model-b", label: "モデルB" },
		],
	});
	await waitFor(() => expect(h.hook.result.current.phase.kind).toBe("ready"));
	expect(h.client.toolchainArtifactSource).toHaveBeenCalledWith(
		"artifact:codex@1",
		"codex-settings",
		undefined,
		expect.any(AbortSignal),
	);
	const form = h.hook.result.current.snapshot["codex-settings"] as {
		revision: number;
		fields: { id: string; options: string[] }[];
		defaults: Record<string, string>;
	};
	expect(form.revision).toBe(3);
	expect(form.fields.find((f) => f.id === "resourceId")?.options).toEqual([
		"",
		"model-a",
		"model-b",
	]);
	expect(form.defaults).toEqual({
		expectedRevision: "7",
		enabled: "true",
		runnerId: "local",
		workspaceId: "eumenes",
		resourceId: "model-a",
	});
	h.cache.clear();
});

test("a saved model that is no longer offered stays visible with a warning label", async () => {
	const h = setup({
		settings: { ...saved, resourceId: "gone" },
		resources: [{ id: "model-b", label: "モデルB" }],
	});
	await waitFor(() => expect(h.hook.result.current.phase.kind).toBe("ready"));
	const form = h.hook.result.current.snapshot["codex-settings"] as {
		fields: {
			id: string;
			options: string[];
			optionLabels: Record<string, string>;
		}[];
	};
	const field = form.fields.find((f) => f.id === "resourceId")!;
	expect(field.options).toContain("gone");
	expect(field.optionLabels.gone).toBe(
		"保存済みのモデル（現在は利用できません）",
	);
	h.cache.clear();
});

test("with no model registered the placeholder asks to add one", async () => {
	const h = setup({ settings: { ...saved, resourceId: null }, resources: [] });
	await waitFor(() => expect(h.hook.result.current.phase.kind).toBe("ready"));
	const form = h.hook.result.current.snapshot["codex-settings"] as {
		fields: { id: string; optionLabels: Record<string, string> }[];
	};
	expect(form.fields.find((f) => f.id === "resourceId")?.optionLabels[""]).toBe(
		"AI接続の設定でCodexのモデルを追加してください",
	);
	h.cache.clear();
});

test("a failed read shows an error and local actions are refused", async () => {
	const h = setup({ settings: saved, resources: [] });
	await waitFor(() => expect(h.hook.result.current.phase.kind).toBe("ready"));
	h.client.toolchainArtifactSource.mockRejectedValue(new Error("offline"));
	await act(async () => {
		await h.cache.invalidateQueries();
	});
	await waitFor(() => expect(h.hook.result.current.phase.kind).toBe("error"));
	expect(
		await h.hook.result.current.local({} as never, {} as never),
	).toMatchObject({ status: "rejected" });
	h.cache.clear();
});

test("the unregistered-model refusal is explained and settling re-reads the source", async () => {
	const h = setup({ settings: saved, resources: [] });
	await waitFor(() => expect(h.hook.result.current.phase.kind).toBe("ready"));
	expect(
		h.hook.result.current.describeRejection?.(
			"codex_configuration_unregistered",
			[],
		),
	).toBe("保存済みのCodexモデルを指定してください");
	expect(
		h.hook.result.current.describeRejection?.("other", []),
	).toBeUndefined();
	const before = h.client.toolchainArtifactSource.mock.calls.length;
	await act(async () => {
		await h.hook.result.current.settled(
			{} as never,
			{} as never,
			{} as never,
			undefined,
		);
	});
	expect(h.client.toolchainArtifactSource.mock.calls.length).toBe(before + 1);
	h.cache.clear();
});
