import { ArtifactRenderer, compileArtifact } from "@eumenes/artifact-ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	cleanup,
	render,
	renderHook,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { PropsWithChildren } from "react";
import type { TerminalsResource } from "@eumenes/artifact-ui";
import { createClient } from "../../../client";
import bundle from "../../../api/domains/capabilities/bundles/cli.bundle.json";
import { artifactDefinitionV1 } from "../../../api/domains/capabilities/contracts";
import { shellWebAdapter } from "../domains/shell/toolchain-adapter";
import { toolchainWebAdapters } from "./toolchain-adapters";

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});
const definition = JSON.stringify({
	view: "terminal-workspace",
	source: "shell",
	title: "CLI",
});
test("CLI uses the common terminal renderer, own labels and auto-start action", async () => {
	const dispatch = vi.fn(async () => ({
		status: "accepted" as const,
		message: "",
	}));
	const resource: TerminalsResource = {
		kind: "terminal-workspace",
		revision: 1,
		available: true,
		sessions: [],
		startingLabel: "CLIを起動しています…",
		unavailableMessage: "ログインシェルが見つかりません。",
	};
	expect(
		compileArtifact(definition, { shell: resource }).request,
	).toMatchObject({ source: "shell" });
	const rendered = render(
		<ArtifactRenderer
			definition={definition}
			runtime={{
				snapshot: { shell: resource },
				dispatch,
				openTerminal: () => ({
					output: { subscribe: () => () => {} },
					input: () => {},
					resize: () => {},
				}),
			}}
		/>,
	);
	await waitFor(() =>
		expect(dispatch).toHaveBeenCalledWith(
			expect.objectContaining({ action: "terminal-start", source: "shell" }),
		),
	);
	expect(screen.getByText("CLIを起動しています…")).toBeTruthy();
	rendered.rerender(
		<ArtifactRenderer
			definition={definition}
			runtime={{
				snapshot: { shell: { ...resource, available: false } },
				dispatch,
			}}
		/>,
	);
	expect(screen.getByRole("alert").textContent).toBe(
		"ログインシェルが見つかりません。",
	);
});

test("registered shell adapter reads sources, keeps reconnect state and calls shell API for local start", async () => {
	const artifact = artifactDefinitionV1.parse(bundle.artifacts[0]);
	const calls: string[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			calls.push(url);
			if (url.includes("/sources/"))
				return Response.json({
					revision: 1,
					data: { available: true, revision: 1, limit: 4, sessions: [] },
				});
			if (url.endsWith("/api/shell/sessions"))
				return Response.json({
					id: "shell",
					title: "CLI",
					kind: "shell",
					status: "running",
					run: 1,
					startedAt: "now",
				});
			throw new Error(`unexpected:${url}:${init?.method}`);
		}),
	);
	const client = createClient("http://127.0.0.1:8787", "test-token");
	const query = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const wrapper = ({ children }: PropsWithChildren) => (
		<QueryClientProvider client={query}>{children}</QueryClientProvider>
	);
	const hook = renderHook(
		() =>
			shellWebAdapter.useArtifact({
				client,
				artifact,
				artifactRevisionId: "artifact:cli.workspace@1",
				targetRef: undefined,
				setTargetRef: () => {},
				notify: () => {},
				visible: true,
				catalog: [],
				documentFields: {},
				documentFieldsReady: true,
				drafts: {},
			}),
		{ wrapper },
	);
	await waitFor(() => expect(hook.result.current.phase.kind).toBe("ready"));
	expect(hook.result.current.snapshot.shell).toMatchObject({
		kind: "terminal-workspace",
		startNeeded: true,
	});
	const receipt = await hook.result.current.local(artifact.actionBindings[0]!, {
		id: "start",
		action: "terminal-start",
		source: "shell",
		revision: 1,
		values: {},
	});
	expect(receipt.status).toBe("accepted");
	expect(calls.some((url) => url.endsWith("/api/shell/sessions"))).toBe(true);
	expect(toolchainWebAdapters.get("adapter:shell@1")).toBe(shellWebAdapter);
	query.clear();
});
