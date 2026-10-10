import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { Settings } from "../../../../../api/domains/settings/contracts";
import { settingsFixture } from "./fixture";
import { SettingsPage } from "../SettingsPage";
import { LarmConnectionCard } from "./larm-connection";

afterEach(cleanup);

function setup(
	over: {
		dirty?: boolean;
		details?: unknown;
		mutate?: (s: Settings) => void;
	} = {},
) {
	const value = settingsFixture();
	over.mutate?.(value);
	const draft = settingsFixture();
	draft.larm.baseUrl = "http://127.0.0.1:8080";
	const change = vi.fn((fn: (s: Settings) => void) => fn(draft));
	const probe = vi.fn(async () => {});
	render(
		<LarmConnectionCard
			value={value}
			change={change}
			dirty={over.dirty ?? false}
			details={(over.details ?? { data: undefined }) as never}
			probe={probe}
		/>,
	);
	return { change, probe, draft };
}

test("while the provider details are unknown, only the form and the check button show", () => {
	setup();
	expect((screen.getByLabelText("Profile") as HTMLInputElement).value).toBe(
		"SAAA-gemma4-26b",
	);
	expect((screen.getByLabelText("LARMのURL") as HTMLInputElement).value).toBe(
		"",
	);
	expect(screen.queryByText(/会話:/)).toBeNull();
	expect(
		(
			screen.getByRole("button", { name: "LARMの接続を確認" }) as HTMLElement
		).hasAttribute("disabled"),
	).toBe(false);
});

test("the configured URL and each provider the LARM reports are listed", () => {
	setup({
		mutate: (s) => {
			s.larm.baseUrl = "http://127.0.0.1:8080";
		},
		details: {
			data: {
				profile: "SAAA-gemma4-26b",
				providers: [
					{
						name: "llm",
						model: "gemma-4",
						baseUrl: "http://127.0.0.1:8080/v1",
						protocol: "openai",
					},
					{
						name: "tts",
						model: "voice-1",
						baseUrl: "http://127.0.0.1:8081",
						protocol: "openai",
					},
				],
			},
		},
	});
	expect((screen.getByLabelText("LARMのURL") as HTMLInputElement).value).toBe(
		"http://127.0.0.1:8080",
	);
	expect(screen.getByText(/会話: gemma-4/)).toBeTruthy();
	expect(screen.getByText(/読み上げ: voice-1/)).toBeTruthy();
	expect(screen.getByText("http://127.0.0.1:8080/v1")).toBeTruthy();
});

test("unsaved changes disable the connection check; otherwise it probes larm", () => {
	const dirty = setup({ dirty: true });
	const button = screen.getByRole("button", { name: "LARMの接続を確認" });
	expect((button as HTMLButtonElement).disabled).toBe(true);
	fireEvent.click(button);
	expect(dirty.probe).not.toHaveBeenCalled();
	cleanup();

	const clean = setup({ dirty: false });
	fireEvent.click(screen.getByRole("button", { name: "LARMの接続を確認" }));
	expect(clean.probe).toHaveBeenCalledWith("larm");
});

test("clearing the URL field stores null so the backend default is used", () => {
	const { draft } = setup({
		mutate: (s) => {
			s.larm.baseUrl = "http://127.0.0.1:8080";
		},
	});
	fireEvent.change(screen.getByLabelText("LARMのURL"), {
		target: { value: "" },
	});
	expect(draft.larm.baseUrl).toBeNull();
});

async function applyWithUrl(confirmAnswer: boolean, savedUrl: string | null) {
	const saved = settingsFixture();
	saved.larm.baseUrl = savedUrl;
	const client = {
		identity: "larm-origin-test",
		settings: vi.fn(async () => saved),
		settingsDiagnostics: vi.fn(async () => {
			throw new Error("not_needed");
		}),
		inferenceUsage: vi.fn(async () => []),
		inferenceProbes: vi.fn(async () => []),
		larmDetails: vi.fn(async () => {
			throw new Error("not_needed");
		}),
		applySettings: vi.fn(async (input: { settings: Settings }) => ({
			...input.settings,
			revision: input.settings.revision + 1,
		})),
	};
	const confirm = vi.spyOn(window, "confirm").mockReturnValue(confirmAnswer);
	const cache = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	render(
		<QueryClientProvider client={cache}>
			<SettingsPage
				client={client as never}
				onDirty={vi.fn()}
				onSaved={vi.fn()}
			/>
		</QueryClientProvider>,
	);
	fireEvent.click(await screen.findByRole("button", { name: "接続先" }));
	fireEvent.change(await screen.findByLabelText("LARMのURL"), {
		target: { value: "http://127.0.0.1:9999/path" },
	});
	fireEvent.click(screen.getByRole("button", { name: "変更を適用" }));
	return { client, confirm };
}

test("changing the LARM origin asks first and cancelling does not save", async () => {
	const { client, confirm } = await applyWithUrl(
		false,
		"http://127.0.0.1:8080",
	);
	await waitFor(() => expect(confirm).toHaveBeenCalled());
	expect(confirm.mock.calls[0]![0]).toContain("http://127.0.0.1:9999");
	expect(client.applySettings).not.toHaveBeenCalled();
	confirm.mockRestore();
});

test("confirming sends confirmLarmOrigin; a first-time URL needs no confirmation", async () => {
	const changed = await applyWithUrl(true, "http://127.0.0.1:8080");
	await waitFor(() => expect(changed.client.applySettings).toHaveBeenCalled());
	expect(changed.client.applySettings.mock.calls[0]![0]).toMatchObject({
		confirmLarmOrigin: "http://127.0.0.1:9999",
	});
	changed.confirm.mockRestore();
	cleanup();

	const first = await applyWithUrl(true, null);
	await waitFor(() => expect(first.client.applySettings).toHaveBeenCalled());
	expect(first.confirm).not.toHaveBeenCalled();
	expect(first.client.applySettings.mock.calls[0]![0]).not.toHaveProperty(
		"confirmLarmOrigin",
	);
	first.confirm.mockRestore();
});
