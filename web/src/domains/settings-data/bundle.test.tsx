import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import type { ArtifactDefinitionV1 } from "../../../../api/domains/capabilities/contracts";
import { createSettingsBackend, newCache, Screens } from "./settings.fixture";

afterEach(cleanup);

/** The shipped registration, read from disk: the screens run on exactly what is registered. */
const bundle = JSON.parse(
	readFileSync(
		resolve(
			process.cwd(),
			"api/domains/capabilities/bundles/settings.bundle.json",
		),
		"utf8",
	),
) as { artifacts: ArtifactDefinitionV1[] };
// The records screen has its own adapter and tests.
const artifacts = Object.fromEntries(
	bundle.artifacts
		.filter((a) => a.id !== "settings.records")
		.map((a) => [a.id.replace(/^settings\./, ""), a]),
);
const fieldLabel = (id: string) =>
	Object.values(artifacts)
		.flatMap((a) => a.fields ?? [])
		.find((f) => f.fieldId === id)!.label;

function open(cloud?: boolean, claude?: boolean) {
	const backend = createSettingsBackend({ artifacts, cloud, claude });
	render(<Screens backend={backend} start="hub" cache={newCache(backend)} />);
	return backend;
}

test("the shipped bundle drives conversation edit, review and apply from the hub", async () => {
	const backend = open();
	fireEvent.click(await screen.findByRole("button", { name: "会話" }));
	fireEvent.change(
		await screen.findByLabelText(fieldLabel("conversation.persona")),
		{
			target: { value: "sage" },
		},
	);
	fireEvent.change(
		screen.getByLabelText(fieldLabel("conversation.agent-name")),
		{
			target: { value: "登録どおり" },
		},
	);
	fireEvent.click(screen.getByRole("button", { name: "変更一覧を開く" }));
	await screen.findByText("会話 / 口調");
	fireEvent.click(
		screen.getByRole("button", { name: "設定の変更をすべて適用" }),
	);
	await screen.findAllByText("変更を適用しました");
	expect(backend.sent[0]!.input).toEqual({
		expectedRevision: 1,
		changes: expect.arrayContaining([
			{ fieldId: "conversation.persona", value: "sage" },
			{ fieldId: "conversation.agent-name", value: "登録どおり" },
		]),
	});
	expect(backend.saved().general).toMatchObject({
		persona: "sage",
		agentName: "登録どおり",
	});
});

test("the shipped bundle's voice fields, languages source and review labels work together", async () => {
	const backend = open();
	fireEvent.click(await screen.findByRole("button", { name: "音声と入力" }));
	fireEvent.change(
		await screen.findByLabelText(new RegExp(`^${fieldLabel("speech.volume")}`)),
		{
			target: { value: "0.4" },
		},
	);
	fireEvent.click(screen.getByRole("button", { name: "聞き取り" }));
	fireEvent.click(await screen.findByLabelText("英語"));
	fireEvent.click(screen.getByRole("button", { name: "変更一覧を開く" }));
	await screen.findByText(`音声と入力 / ${fieldLabel("input.languages")}`);
	expect(screen.getByText("日本語、英語")).toBeTruthy();
	fireEvent.click(
		screen.getByRole("button", { name: "設定の変更をすべて適用" }),
	);
	await screen.findAllByText("変更を適用しました");
	await waitFor(() => expect(backend.saved().voice.outputVolume).toBe(0.4));
	expect(backend.saved().general.asrLanguages).toEqual(["ja"]);
	expect(backend.sent[0]!.input).toMatchObject({
		changes: expect.arrayContaining([
			{ fieldId: "speech.volume", value: "0.4" },
			{ fieldId: "input.languages", value: '["ja"]' },
		]),
	});
});

test("the shipped AI and connections screen lists each connection as a group with its registered fields", async () => {
	const backend = open(false);
	fireEvent.click(await screen.findByRole("button", { name: "AIと接続" }));
	fireEvent.click(await screen.findByRole("button", { name: "クラウド音声" }));
	fireEvent.change(
		await screen.findByLabelText(fieldLabel("connection.name")),
		{
			target: { value: "登録どおりの接続" },
		},
	);
	fireEvent.click(
		screen.getByRole("button", { name: "設定の変更をすべて保存" }),
	);
	await screen.findAllByText("変更を適用しました");
	expect(backend.sent[0]!.input).toMatchObject({
		changes: [
			{
				fieldId: "connection.name",
				target: backend.cloud.connectionId,
				value: "登録どおりの接続",
			},
		],
	});
});

test("the shipped AI screen offers the auth method and the setup token of a Claude Agent SDK connection only", async () => {
	const backend = open(false, true);
	fireEvent.click(await screen.findByRole("button", { name: "AIと接続" }));
	fireEvent.click(await screen.findByRole("button", { name: "クラウド音声" }));
	expect(screen.queryByLabelText(fieldLabel("connection.auth"))).toBeNull();
	fireEvent.click(await screen.findByRole("button", { name: "Claude購読" }));
	const auth = (await screen.findByLabelText(
		fieldLabel("connection.auth"),
	)) as HTMLSelectElement;
	expect([...auth.options].map((o) => o.textContent)).toEqual(
		expect.arrayContaining(["サブスクリプション", "APIキー"]),
	);
	expect(screen.getByLabelText(fieldLabel("connection.api-key"))).toBeDefined();
	expect(fieldLabel("connection.api-key")).toContain("setup-token");
	expect(
		bundle.artifacts
			.flatMap((a) => a.fields ?? [])
			.some((f) => JSON.stringify(f).includes("Managed")),
	).toBe(false);
	fireEvent.change(auth, { target: { value: "api-key" } });
	fireEvent.click(
		screen.getByRole("button", { name: "設定の変更をすべて保存" }),
	);
	await screen.findAllByText("変更を適用しました");
	expect(backend.sent[0]!.input).toMatchObject({
		changes: [
			{
				fieldId: "connection.auth",
				target: backend.claude.connectionId,
				value: "api-key",
			},
		],
	});
});

test("the shipped conversation screen selects the sub-agent AI, none meaning LARM", async () => {
	const backend = open(false, true);
	fireEvent.click(await screen.findByRole("button", { name: "会話" }));
	const select = (await screen.findByLabelText(
		fieldLabel("subagent.resource"),
	)) as HTMLSelectElement;
	expect(select.value).toBe("");
	expect(backend.sent).toHaveLength(0);
});
