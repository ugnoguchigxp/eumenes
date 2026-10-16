import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, test, vi } from "vitest";
import type { Settings } from "../../../../api/domains/settings/contracts";
import { useConversationModel } from ".";
import { settingsFixture } from "./sections/fixture";

afterEach(cleanup);

const connection = (
	id: string,
	auth: "subscription" | "api-key",
	enabled = true,
) => ({
	id,
	kind: "claude-agent-sdk" as const,
	auth,
	name: `connection-${auth}`,
	baseUrl: "https://example.test",
	enabled,
	epoch: 0,
	envRef: auth === "api-key" ? "TEST_KEY" : null,
});
const subscriptionId = crypto.randomUUID();
const apiKeyId = crypto.randomUUID();
const registeredId = crypto.randomUUID();

function settings(): Settings {
	const base = settingsFixture();
	return {
		...base,
		larm: { ...base.larm, profile: "profile-x" },
		connections: [
			connection(subscriptionId, "subscription"),
			connection(apiKeyId, "api-key", false),
		],
		resources: [
			{
				id: registeredId,
				connectionId: subscriptionId,
				purpose: "llm",
				model: "model-a",
				contextWindow: 100_000,
				voice: null,
			},
		],
	};
}

function setup(saved = settings()) {
	const client = {
		identity: "test",
		settings: vi.fn(async () => saved),
		larmProfiles: vi.fn(async () => [
			{ profile: "profile-x", model: "larm-m" },
		]),
		applySettings: vi.fn(async (input: { settings: Settings }) => ({
			...input.settings,
			revision: saved.revision + 1,
		})),
	};
	const queries = new QueryClient();
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={queries}>{children}</QueryClientProvider>
	);
	const hook = renderHook(() => useConversationModel(client as never), {
		wrapper,
	});
	return { client, hook };
}

test("options group LARM profiles and registered resources by billing path, without the connection's other models", async () => {
	const { hook } = setup();
	await waitFor(() =>
		expect(hook.result.current.options.map((o) => o.label)).toEqual([
			"larm-m",
			"model-a",
		]),
	);
	expect(hook.result.current.options.map((o) => o.groupLabel)).toEqual([
		"LARM",
		"Claude（サブスク）",
	]);
	expect(hook.result.current.options[1]?.id).toBe(registeredId);
});

test("the group label of an api-key connection shows the API billing path", async () => {
	const saved = settings();
	saved.connections[0] = connection(subscriptionId, "api-key");
	const { hook } = setup(saved);
	await waitFor(() =>
		expect(hook.result.current.options.at(-1)?.groupLabel).toBe(
			"Claude（API）",
		),
	);
});

test("picking a registered resource selects it without adding one", async () => {
	const { client, hook } = setup();
	await waitFor(() => expect(hook.result.current.options).toHaveLength(2));
	await act(() => hook.result.current.select(registeredId));
	const sent = client.applySettings.mock.calls[0]?.[0].settings as Settings;
	expect(sent.resources).toHaveLength(1);
	expect(sent.routes.llm.fallbackId).toBe(registeredId);
});

test("picking a LARM profile saves the profile and leaves cloud-only", async () => {
	const saved = settings();
	saved.routes.llm = {
		mode: "cloud-only",
		cloudAllowed: true,
		fallbackId: registeredId,
		epoch: 0,
	};
	const { client, hook } = setup(saved);
	await waitFor(() => expect(hook.result.current.selected).toBe(registeredId));
	await act(() => hook.result.current.select("larm:profile-x"));
	const sent = client.applySettings.mock.calls[0]?.[0].settings as Settings;
	expect(sent.larm.profile).toBe("profile-x");
	expect(sent.routes.llm.mode).toBe("larm-preferred");
});
