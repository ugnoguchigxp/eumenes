import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import type { Settings } from "../../../api/domains/settings/contracts";
import { useConversationModel } from "../domains/settings";
import { settingsFixture } from "../domains/settings/sections/fixture";
import { ConversationModelSelect } from "./ConversationModelSelect";

beforeAll(() => {
	// Radix Select needs these in jsdom.
	Element.prototype.hasPointerCapture = () => false;
	Element.prototype.setPointerCapture = () => {};
	Element.prototype.releasePointerCapture = () => {};
	Element.prototype.scrollIntoView = () => {};
	globalThis.ResizeObserver ??= class {
		observe() {}
		unobserve() {}
		disconnect() {}
	};
});
afterEach(cleanup);

const connectionId = crypto.randomUUID();
const resourceId = crypto.randomUUID();

function makeClient() {
	const saved: Settings = {
		...settingsFixture(),
		larm: { ...settingsFixture().larm, profile: "profile-x" },
		connections: [
			{
				id: connectionId,
				kind: "claude-agent-sdk",
				auth: "subscription",
				name: "connection",
				baseUrl: "https://example.test",
				enabled: true,
				epoch: 0,
				envRef: null,
			},
		],
		resources: [
			{
				id: resourceId,
				connectionId,
				purpose: "llm",
				model: "model-a",
				contextWindow: 100_000,
				voice: null,
			},
		],
	};
	return {
		identity: "test",
		settings: vi.fn(async () => saved),
		larmProfiles: vi.fn(async () => [
			{ profile: "profile-x", model: "larm-m" },
		]),
		connectionModels: vi.fn(async () => ({
			models: [
				{ id: "model-a", displayName: "Model A", contextWindow: 100_000 },
				{ id: "model-b", displayName: "Model B", contextWindow: 500_000 },
			],
			account: { auth: "subscription" as const, subscriptionType: null },
		})),
		applySettings: vi.fn(async (input: { settings: Settings }) => ({
			...input.settings,
			revision: saved.revision + 1,
		})),
	};
}

function View({
	client,
	running,
	billingPath,
}: {
	client: ReturnType<typeof makeClient>;
	running: boolean;
	billingPath?: string | null;
}) {
	const model = useConversationModel(client as never);
	return (
		<ConversationModelSelect
			model={model}
			running={running}
			actualModel={{ source: "cloud", model: "model-a", billingPath }}
		/>
	);
}

function renderView(running = false, billingPath?: string | null) {
	const client = makeClient();
	const view = (r: boolean) => (
		<QueryClientProvider client={queries}>
			<View client={client} running={r} billingPath={billingPath} />
		</QueryClientProvider>
	);
	const queries = new QueryClient();
	const result = render(view(running));
	return { client, result, view };
}

test("renders the select with the billing path and the last used model as tooltip", async () => {
	renderView();
	const trigger = await screen.findByRole("combobox", {
		name: "会話エージェント",
	});
	await waitFor(() => expect(trigger.textContent).toContain("LARM / larm-m"));
	expect(trigger.getAttribute("title")).toContain(
		"直近の利用: クラウド / model-a",
	);
	expect((trigger as HTMLButtonElement).disabled).toBe(false);
});

test("the tooltip names the billing path that served the last answer", async () => {
	renderView(false, "claude-subscription");
	const trigger = await screen.findByRole("combobox", {
		name: "会話エージェント",
	});
	await waitFor(() =>
		expect(trigger.getAttribute("title")).toContain(
			"直近の利用: Claude（サブスク） / model-a",
		),
	);
});

test("is disabled with a hint while an answer is running", async () => {
	renderView(true);
	const trigger = await screen.findByRole("combobox", {
		name: "会話エージェント",
	});
	expect((trigger as HTMLButtonElement).disabled).toBe(true);
	expect(screen.getByRole("status").textContent).toContain(
		"回答中は切り替えできません",
	);
});

test("picking an item calls applySettings and shows the next-utterance hint", async () => {
	const { client, result, view } = renderView();
	const trigger = await screen.findByRole("combobox", {
		name: "会話エージェント",
	});
	await waitFor(() => expect(client.connectionModels).toHaveBeenCalled());
	fireEvent.keyDown(trigger, { key: "Enter" });
	fireEvent.click(await screen.findByRole("option", { name: "Model B" }));
	await waitFor(() => expect(client.applySettings).toHaveBeenCalledTimes(1));
	const sent = client.applySettings.mock.calls[0]?.[0].settings as Settings;
	expect(sent.resources.some((r) => r.model === "model-b")).toBe(true);
	await waitFor(() =>
		expect(screen.getByRole("status").textContent).toContain(
			"次の発言から適用",
		),
	);
	// The hint ends once the next utterance starts.
	result.rerender(view(true));
	expect(screen.getByRole("status").textContent).toContain("回答中");
});
