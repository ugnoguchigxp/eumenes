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
import { ReasoningSelect } from "./ReasoningSelect";
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

/** The catalog's levels of the cloud model (`model-a`); `null` leaves the model without a `reasoning` entry. */
function makeClient(
	cloudEfforts: string[] | null = ["low", "xhigh"],
	savedEffort = "low",
) {
	const saved: Settings = {
		...settingsFixture(),
		general: { ...settingsFixture().general, reasoningEffort: savedEffort },
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
				{
					id: "model-a",
					displayName: "model-a",
					contextWindow: null,
					...(cloudEfforts
						? { reasoning: { efforts: cloudEfforts, default: "low" } }
						: {}),
				},
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
		<>
			<ConversationModelSelect
				model={model}
				running={running}
				actualModel={{ source: "cloud", model: "model-a", billingPath }}
			/>
			<ReasoningSelect model={model} running={running} />
		</>
	);
}

function renderView(
	running = false,
	billingPath?: string | null,
	client = makeClient(),
) {
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
	await waitFor(() => expect(trigger.textContent).toContain("larm-m"));
	expect(trigger.textContent).not.toContain("LARM /");
	expect(trigger.getAttribute("title")).toContain("現在の経路: LARM / larm-m");
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

test("is disabled without a hint while an answer is running", async () => {
	renderView(true);
	const trigger = await screen.findByRole("combobox", {
		name: "会話エージェント",
	});
	expect((trigger as HTMLButtonElement).disabled).toBe(true);
	expect(screen.queryByRole("status")).toBeNull();
});

test("picking an item calls applySettings and shows the next-utterance hint", async () => {
	const { client, result, view } = renderView();
	const trigger = await screen.findByRole("combobox", {
		name: "会話エージェント",
	});
	fireEvent.keyDown(trigger, { key: "Enter" });
	fireEvent.click(await screen.findByRole("option", { name: "model-a" }));
	await waitFor(() => expect(client.applySettings).toHaveBeenCalledTimes(1));
	const sent = client.applySettings.mock.calls[0]?.[0].settings as Settings;
	expect(sent.routes.llm.fallbackId).toBe(resourceId);
	await waitFor(() =>
		expect(screen.getByRole("status").textContent).toContain(
			"次の発言から適用",
		),
	);
	// The hint ends once the next utterance starts.
	result.rerender(view(true));
	expect(screen.queryByRole("status")).toBeNull();
});

const effortTrigger = () =>
	screen.findByRole("combobox", {
		name: "思考レベル",
	}) as Promise<HTMLButtonElement>;
const optionNames = () =>
	screen.getAllByRole("option").map((option) => option.textContent);

test("the thinking level beside the model offers LARM's declared levels and saves the chosen one", async () => {
	const { client } = renderView();
	const trigger = await effortTrigger();
	await waitFor(() => expect(trigger.textContent).toContain("low"));
	expect(trigger.disabled).toBe(false);
	fireEvent.keyDown(trigger, { key: "Enter" });
	// `off` is not a level LARM accepts; nothing beyond the declared ones is offered.
	expect(optionNames()).toEqual(["low", "medium", "high"]);
	fireEvent.click(screen.getByRole("option", { name: "medium" }));
	await waitFor(() => expect(client.applySettings).toHaveBeenCalledTimes(1));
	const sent = client.applySettings.mock.calls[0]?.[0].settings as Settings;
	expect(sent.general.reasoningEffort).toBe("medium");
	// The model route is untouched by a level change.
	expect(sent.routes.llm.fallbackId).toBeNull();
});

test("on a cloud model the levels are the catalog's, up to its highest, and a saved level outside them is not shown as chosen", async () => {
	const client = makeClient(["low", "medium", "high", "xhigh", "max"], "xhigh");
	const saved = await client.settings();
	client.settings.mockResolvedValue({
		...saved,
		routes: {
			...saved.routes,
			llm: { ...saved.routes.llm, mode: "cloud-only", fallbackId: resourceId },
		},
	});
	renderView(false, null, client);
	const trigger = await effortTrigger();
	await waitFor(() => expect(trigger.textContent).toContain("xhigh"));
	fireEvent.keyDown(trigger, { key: "Enter" });
	expect(optionNames()).toEqual(["low", "medium", "high", "xhigh", "max"]);
	fireEvent.click(screen.getByRole("option", { name: "max" }));
	await waitFor(() => expect(client.applySettings).toHaveBeenCalledTimes(1));
	const sent = client.applySettings.mock.calls[0]?.[0].settings as Settings;
	expect(sent.general.reasoningEffort).toBe("max");
});

test("switching to a model that does not accept the saved level saves the model's default in the same save", async () => {
	const { client } = renderView(
		false,
		null,
		makeClient(["low", "xhigh"], "medium"),
	);
	const model = await screen.findByRole("combobox", {
		name: "会話エージェント",
	});
	// Wait for the catalog: the cloud option knows its levels once the list is read.
	await waitFor(() => expect(client.connectionModels).toHaveBeenCalled());
	fireEvent.keyDown(model, { key: "Enter" });
	fireEvent.click(await screen.findByRole("option", { name: "model-a" }));
	await waitFor(() => expect(client.applySettings).toHaveBeenCalledTimes(1));
	const sent = client.applySettings.mock.calls[0]?.[0].settings as Settings;
	expect(sent.routes.llm.fallbackId).toBe(resourceId);
	expect(sent.general.reasoningEffort).toBe("low");
});

test("switching to a model that accepts the saved level keeps it", async () => {
	const { client } = renderView(
		false,
		null,
		makeClient(["low", "medium", "xhigh"], "medium"),
	);
	const model = await screen.findByRole("combobox", {
		name: "会話エージェント",
	});
	await waitFor(() => expect(client.connectionModels).toHaveBeenCalled());
	fireEvent.keyDown(model, { key: "Enter" });
	fireEvent.click(await screen.findByRole("option", { name: "model-a" }));
	await waitFor(() => expect(client.applySettings).toHaveBeenCalledTimes(1));
	const sent = client.applySettings.mock.calls[0]?.[0].settings as Settings;
	expect(sent.general.reasoningEffort).toBe("medium");
});

test("a model with no level to choose, or an unread catalog, leaves the level locked", async () => {
	// The saved route is the cloud model: no `reasoning` in its catalog entry means the levels are not known.
	const client = makeClient(null);
	const saved = await client.settings();
	client.settings.mockResolvedValue({
		...saved,
		routes: {
			...saved.routes,
			llm: { ...saved.routes.llm, mode: "cloud-only", fallbackId: resourceId },
		},
	});
	renderView(false, null, client);
	const trigger = await effortTrigger();
	await waitFor(() => expect(client.connectionModels).toHaveBeenCalled());
	expect(trigger.disabled).toBe(true);
	expect(trigger.getAttribute("title")).toContain(
		"選べる思考レベルがありません",
	);
});

test("the thinking level is locked while an answer is running", async () => {
	renderView(true);
	expect((await effortTrigger()).disabled).toBe(true);
});
