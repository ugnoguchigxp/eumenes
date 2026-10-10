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
import { ApiError } from "../../../../../client";
import { SettingsPage } from "../SettingsPage";
import { settingsFixture } from "./fixture";

// The cloud registration form is validated and saved by SettingsPage, so these tests drive it there.
const caches: QueryClient[] = [];
afterEach(() => {
	cleanup();
	for (const cache of caches.splice(0)) cache.clear();
});

function setup(applyError?: unknown) {
	const saved = settingsFixture();
	const client = {
		identity: "cloud-add-test",
		settings: vi.fn(async () => saved),
		settingsDiagnostics: vi.fn(async () => {
			throw new Error("not_needed");
		}),
		inferenceUsage: vi.fn(async () => []),
		inferenceProbes: vi.fn(async () => []),
		larmDetails: vi.fn(async () => {
			throw new Error("not_needed");
		}),
		applySettings: vi.fn(async (input: { settings: Settings }) => {
			if (applyError) throw applyError;
			return { ...input.settings, revision: input.settings.revision + 1 };
		}),
	};
	const onSaved = vi.fn();
	const cache = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	caches.push(cache);
	render(
		<QueryClientProvider client={cache}>
			<SettingsPage
				client={client as never}
				onDirty={vi.fn()}
				onSaved={onSaved}
			/>
		</QueryClientProvider>,
	);
	return { client, onSaved };
}
async function openForm() {
	fireEvent.click(await screen.findByRole("button", { name: "接続先" }));
	fireEvent.click(
		await screen.findByRole("button", { name: "クラウドAPIを登録" }),
	);
}
const fill = (label: string, value: string) =>
	fireEvent.change(screen.getByLabelText(label), { target: { value } });
const submit = () =>
	fireEvent.click(screen.getByRole("button", { name: "登録内容を追加" }));
const footer = () => document.querySelector(".settings-footer output")!;
const fillValid = () => {
	fill("接続名", "OpenAI");
	fill("APIのベースURL", "https://api.example.com/v1");
	fill("モデル名", "gpt-test");
};

test("a blank form is not added and stays open", async () => {
	const { client } = setup();
	await openForm();
	submit();
	expect(screen.getByText("クラウドAPIの登録")).toBeTruthy();
	expect(footer().textContent).not.toContain("登録内容を確認して");
	expect(client.applySettings).not.toHaveBeenCalled();
});

test("a valid connection still needs an API key or an environment variable name", async () => {
	setup();
	await openForm();
	fillValid();
	submit();
	expect(footer().textContent).toBe("APIキーか環境変数名を指定してください");
	expect(screen.getByText("クラウドAPIの登録")).toBeTruthy();

	fill("APIキー", "sk-test");
	fill("環境変数名（APIキーの代わり）", "OPENAI_API_KEY");
	submit();
	expect(footer().textContent).toBe(
		"APIキーと環境変数はどちらか一方を指定してください",
	);
});

test("an external http URL is rejected by the server and the reason is shown", async () => {
	const { client } = setup(new ApiError(400, "invalid_input"));
	await openForm();
	fill("接続名", "OpenAI");
	fill("APIのベースURL", "http://api.example.com/v1");
	fill("モデル名", "gpt-test");
	fill("APIキー", "sk-test");
	submit();
	await screen.findByText("登録内容を確認して「変更を適用」を押してください");
	fireEvent.click(screen.getByRole("button", { name: "変更を適用" }));
	await waitFor(() =>
		expect(footer().textContent).toBe(
			"適用できませんでした: 入力内容が正しくありません。",
		),
	);
	expect(client.applySettings).toHaveBeenCalledTimes(1);
});

test("a valid https connection is added, then saved with its key", async () => {
	const { client, onSaved } = setup();
	await openForm();
	fillValid();
	fill("APIキー", "sk-test");
	submit();
	await screen.findByText("登録内容を確認して「変更を適用」を押してください");
	// The form closes and the new connection appears in the list.
	expect(screen.queryByText("クラウドAPIの登録")).toBeNull();
	expect(screen.getByDisplayValue("https://api.example.com/v1")).toBeTruthy();

	fireEvent.click(screen.getByRole("button", { name: "変更を適用" }));
	await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
	const input = client.applySettings.mock.calls[0]![0] as unknown as {
		settings: Settings;
		keys: { connectionId: string; value: string }[];
	};
	expect(input.settings.connections).toHaveLength(1);
	expect(input.settings.connections[0]).toMatchObject({
		name: "OpenAI",
		baseUrl: "https://api.example.com/v1",
		envRef: null,
	});
	expect(input.settings.resources[0]).toMatchObject({
		purpose: "llm",
		model: "gpt-test",
	});
	expect(input.keys).toEqual([
		{ connectionId: input.settings.connections[0]!.id, value: "sk-test" },
	]);
	await waitFor(() => expect(footer().textContent).toBe("変更を適用しました"));
});
