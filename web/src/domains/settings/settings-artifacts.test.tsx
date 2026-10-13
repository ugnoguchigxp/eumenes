import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	act,
	cleanup,
	fireEvent,
	render,
	renderHook,
	screen,
	waitFor,
} from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { compileArtifact, type ArtifactEvent } from "@eumenes/artifact-ui";
import type { EumenesClient } from "../../../../client";
import {
	settingsSchema,
	type ApplySettings,
	type Settings,
} from "../../../../api/domains/settings/contracts";
import { settingsFixture } from "./sections/fixture";
import { queryRoots } from "../../queryKeys";
import { SettingsDraftProvider, useSettingsDraft } from "./SettingsDraftHost";
import { SettingsArtifact } from "./SettingsArtifact";
import { SettingsPage } from "./SettingsPage";
import {
	settingsArtifactDefinition,
	type SettingsArtifactId,
} from "./artifact-definition";
import { settingsArtifactRuntime } from "./artifact-runtime";

afterEach(cleanup);
function fixture() {
	let saved = settingsFixture();
	saved.larm.profile = "ornith1.5Strix";
	const apply = vi.fn(async (input: ApplySettings) => {
		saved = settingsSchema.parse(input.settings);
		saved.revision++;
		return saved;
	});
	const client = {
		identity: "settings-artifact-test",
		settings: vi.fn(async () => saved),
		applySettings: apply,
		settingsDiagnostics: async () => ({ keyError: null, connections: [] }),
		inferenceUsage: async () => [],
		inferenceProbes: async () => [],
		larmDetails: async () => ({}),
	} as unknown as EumenesClient;
	const cache = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	cache.setQueryData([queryRoots.settings, client.identity], saved);
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={cache}>
			<SettingsDraftProvider client={client}>{children}</SettingsDraftProvider>
		</QueryClientProvider>
	);
	return { client, apply, wrapper, cache };
}
test("legacy and OpenUI share edits; closing a form keeps its draft, and apply saves through the public client", async () => {
	const f = fixture();
	function Screens() {
		const [view, setView] = useState<"legacy" | SettingsArtifactId | null>(
			"legacy",
		);
		return (
			<>
				<button onClick={() => setView("legacy")}>旧設定</button>
				<button onClick={() => setView("hub")}>設定入口</button>
				<button onClick={() => setView("conversation")}>会話フォーム</button>
				<button onClick={() => setView(null)}>閉じる</button>
				{view === "legacy" ? (
					<SettingsPage
						client={f.client}
						onDirty={() => {}}
						onSaved={() => {}}
					/>
				) : (
					view && (
						<SettingsArtifact
							definition={settingsArtifactDefinition(view)}
							onOpen={setView}
						/>
					)
				)}
			</>
		);
	}
	render(<Screens />, { wrapper: f.wrapper });
	fireEvent.change(screen.getByLabelText("あなたの名前"), {
		target: { value: "共有した名前" },
	});
	fireEvent.click(screen.getByText("設定入口"));
	fireEvent.click(screen.getByRole("button", { name: "会話" }));
	await screen.findByLabelText("AIの名前");
	expect(
		(screen.getByLabelText("あなたの名前") as HTMLInputElement).value,
	).toBe("共有した名前");
	fireEvent.change(screen.getByLabelText("AIの名前"), {
		target: { value: "Amy " },
	});
	expect((screen.getByLabelText("AIの名前") as HTMLInputElement).value).toBe(
		"Amy ",
	);
	fireEvent.change(screen.getByLabelText("口調"), {
		target: { value: "strategist" },
	});
	fireEvent.click(screen.getByText("閉じる"));
	fireEvent.click(screen.getByText("会話フォーム"));
	expect((screen.getByLabelText("AIの名前") as HTMLInputElement).value).toBe(
		"Amy ",
	);
	fireEvent.click(screen.getByRole("button", { name: "変更一覧を開く" }));
	await screen.findByText("会話 / 口調");
	expect(screen.getByText("参謀")).toBeTruthy();
	fireEvent.click(
		screen.getByRole("button", { name: "設定の変更をすべて適用" }),
	);
	await waitFor(() => expect(f.apply).toHaveBeenCalledOnce());
	await screen.findByText("変更を適用しました");
	fireEvent.click(screen.getByText("旧設定"));
	expect((screen.getByLabelText("AIの名前") as HTMLInputElement).value).toBe(
		"Amy",
	);
	expect((screen.getByLabelText("口調") as HTMLInputElement).value).toBe(
		"strategist",
	);
	expect(f.apply.mock.calls[0]![0]).toMatchObject({
		expectedRevision: 1,
		keys: [],
		settings: {
			general: {
				agentName: "Amy ",
				userName: "共有した名前",
				persona: "strategist",
			},
		},
	});
});

test("registered sources compose and reject wrong kind, arbitrary paths, invalid choices and stale events", async () => {
	const f = fixture();
	const hook = renderHook(() => useSettingsDraft(), { wrapper: f.wrapper });
	const runtime = () => settingsArtifactRuntime(hook.result.current, vi.fn());
	const event = (
		values: ArtifactEvent["values"],
		source = "settings-conversation",
	): ArtifactEvent => ({
		id: crypto.randomUUID(),
		source,
		revision: hook.result.current.current().revision,
		action: "settings-edit",
		values,
	});
	const definition = JSON.stringify({
		view: "layout",
		children: [
			JSON.parse(settingsArtifactDefinition("hub")),
			JSON.parse(settingsArtifactDefinition("conversation")),
			JSON.parse(settingsArtifactDefinition("changes")),
		],
	});
	expect(compileArtifact(definition, runtime().snapshot).lang).toContain(
		"Composition",
	);
	expect(() =>
		compileArtifact(settingsArtifactDefinition("conversation"), {
			"settings-conversation": { kind: "components", revision: 1 },
		}),
	).toThrow();
	expect(() =>
		compileArtifact(
			'{"view":"settings-section","source":"settings-conversation","path":"$.credentials"}',
			runtime().snapshot,
		),
	).toThrow();
	for (const ev of [
		event({ fieldId: "$.larm.baseUrl", value: "https://invalid.example" }),
		event({ fieldId: "conversation.persona", value: "unknown" }),
		event({ fieldId: "conversation.agent-name", value: "x".repeat(41) }),
		event({ fieldId: "conversation.agent-name", value: "x", sql: "update" }),
		event(
			{ fieldId: "conversation.agent-name", value: "x" },
			"settings-changes",
		),
	]) {
		let receipt;
		await act(async () => {
			receipt = await runtime().dispatch(ev);
		});
		expect(receipt).toMatchObject({ status: "rejected" });
	}
	const stale = event({ fieldId: "conversation.user-name", value: "古い値" });
	const valid = event({
		fieldId: "conversation.agent-name",
		value: "新しい名前",
	});
	await act(async () => {
		expect(await runtime().dispatch(valid)).toMatchObject({
			status: "accepted",
		});
	});
	await act(async () => {
		expect(await runtime().dispatch(stale)).toMatchObject({
			status: "conflict",
		});
		expect(await runtime().dispatch(valid)).toMatchObject({
			status: "duplicate",
		});
	});
	expect(hook.result.current.value?.general.userName).toBe("");
	act(() =>
		hook.result.current.setKeys([
			{ connectionId: crypto.randomUUID(), value: "never-publish-this-key" },
		]),
	);
	expect(JSON.stringify(runtime().snapshot)).not.toContain(
		"never-publish-this-key",
	);
	expect(f.apply).not.toHaveBeenCalled();
});

test("conversation saves in place and retains the draft and retry ID after a failed save", async () => {
	const f = fixture();
	const open = vi.fn();
	render(
		<SettingsArtifact
			definition={settingsArtifactDefinition("conversation")}
			onOpen={open}
		/>,
		{ wrapper: f.wrapper },
	);
	const save = screen.getByRole("button", { name: "設定の変更をすべて保存" });
	expect(save).toHaveProperty("disabled", true);
	fireEvent.change(screen.getByLabelText("AIの名前"), {
		target: { value: "保存する名前" },
	});
	fireEvent.change(screen.getByLabelText("あなたの名前"), {
		target: { value: "呼び名" },
	});
	fireEvent.change(screen.getByLabelText("口調"), {
		target: { value: "sage" },
	});
	let reject!: (error: Error) => void;
	f.apply.mockImplementationOnce(
		() =>
			new Promise((_resolve, fail) => {
				reject = fail;
			}),
	);
	fireEvent.submit(screen.getByLabelText("AIの名前").closest("form")!);
	await waitFor(() => expect(f.apply).toHaveBeenCalledOnce());
	expect(screen.getByRole("button", { name: "保存中…" })).toHaveProperty(
		"disabled",
		true,
	);
	await act(async () => reject(new Error("network_error")));
	await screen.findByText(/適用できませんでした:/);
	expect(screen.getByLabelText("AIの名前")).toHaveProperty(
		"value",
		"保存する名前",
	);
	const requestId = f.apply.mock.calls[0]![0].requestId;
	fireEvent.click(
		screen.getByRole("button", { name: "設定の変更をすべて保存" }),
	);
	await screen.findByText("変更を適用しました");
	expect(f.apply).toHaveBeenCalledTimes(2);
	expect(f.apply.mock.calls[1]![0].requestId).toBe(requestId);
	expect((await f.client.settings()).general).toMatchObject({
		agentName: "保存する名前",
		userName: "呼び名",
		persona: "sage",
	});
	expect(
		screen.getByRole("button", { name: "設定の変更をすべて保存" }),
	).toHaveProperty("disabled", true);
	expect(screen.getByLabelText("AIの名前")).toBeTruthy();
	expect(open).not.toHaveBeenCalled();
});

test("apply preserves edits made while saving, revision conflicts and stable retry request IDs", async () => {
	const f = fixture();
	const hook = renderHook(() => useSettingsDraft(), { wrapper: f.wrapper });
	let finish!: (value: Settings) => void;
	f.apply.mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				finish = resolve;
			}),
	);
	act(() =>
		hook.result.current.change((s) => {
			s.general.agentName = "送信済み";
		}),
	);
	let saving!: Promise<Settings | null>;
	act(() => {
		saving = hook.result.current.apply();
	});
	act(() =>
		hook.result.current.change((s) => {
			s.general.userName = "追加の入力";
		}),
	);
	await act(async () => {
		const value = structuredClone(f.apply.mock.calls[0]![0].settings);
		value.revision++;
		finish(value);
		await saving;
	});
	expect(hook.result.current.value?.general.userName).toBe("追加の入力");
	expect(hook.result.current.value?.revision).toBe(2);
	expect(hook.result.current.dirty).toBe(true);
	f.apply.mockRejectedValueOnce(new Error("revision_conflict"));
	await act(async () => {
		await hook.result.current.apply();
	});
	expect(hook.result.current.message).toContain("別の画面");
	expect(hook.result.current.value?.general.userName).toBe("追加の入力");
	const failedId = f.apply.mock.calls[1]![0].requestId;
	await act(async () => {
		await hook.result.current.apply();
	});
	expect(f.apply.mock.calls[2]![0].requestId).toBe(failedId);
});
