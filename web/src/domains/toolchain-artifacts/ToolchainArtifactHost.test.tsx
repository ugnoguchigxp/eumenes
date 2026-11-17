import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { artifactDefinitionV1 } from "../../../../api/domains/capabilities/contracts";
import { createClient } from "../../../../client";
import { readScreenState } from "./screen-observation";
import {
	ToolchainArtifactHost,
	type ToolchainArtifactHostProps,
} from "./ToolchainArtifactHost";

afterEach(cleanup);

const revision = "artifact:sample.screen@1";
const adapterRef = "adapter:sample@1";
const observation = () => readScreenState("tab", revision);

function setup(prepareAdapter?: ToolchainArtifactHostProps["prepareAdapter"]) {
	const artifact = artifactDefinitionV1.parse({
		kind: "artifact",
		id: "sample.screen",
		revision: 1,
		title: "試験画面",
		defaultVariant: "standard",
		variants: [{ id: "standard", label: "標準", definition: {} }],
		sourceBindings: [
			{
				source: "sample",
				adapterRef,
				query: "query:sample.data@1",
				target: "none",
			},
		],
		actionBindings: [],
	});
	const client = {
		...createClient("http://127.0.0.1"),
		toolchainArtifact: async () => ({
			artifact,
			artifactRevisionId: revision,
			digest: "test",
			scopeRef: "scope:main",
		}),
	};
	const cache = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const view = (visible: boolean) => (
		<QueryClientProvider client={cache}>
			<ToolchainArtifactHost
				client={client}
				adapters={emptyRegistry}
				artifactRevisionId={revision}
				artifactId="tab"
				prepareAdapter={prepareAdapter}
				visible={visible}
			/>
		</QueryClientProvider>
	);
	return { cache, view };
}

const emptyRegistry = { get: () => undefined };

test("a definition without an installed adapter reports an unavailable screen", async () => {
	const { view } = setup();
	render(view(true));
	expect((await screen.findByRole("alert")).textContent).toBe(
		"この画面はこのアプリでは表示できません。",
	);
	expect(observation()).toMatchObject({ adapterRef, phase: "error" });
});

test("an inactive tab defers its module and a rejected import updates the visible screen", async () => {
	const pending = Promise.withResolvers<"ready">();
	const prepare = vi.fn(() => pending.promise);
	const { cache, view } = setup(prepare);
	const rendered = render(view(false));
	await waitFor(() =>
		expect(cache.getQueryCache().getAll()[0]?.state.status).toBe("success"),
	);
	expect(prepare).not.toHaveBeenCalled();
	expect(observation()).toBeUndefined();
	rendered.rerender(view(true));
	await waitFor(() => expect(prepare).toHaveBeenCalledWith(adapterRef));
	expect(observation()).toMatchObject({ adapterRef, phase: "loading" });
	pending.reject(new Error("module unavailable"));
	expect((await screen.findByRole("alert")).textContent).toBe(
		"この画面はこのアプリでは表示できません。",
	);
	expect(observation()).toMatchObject({ adapterRef, phase: "error" });
});
