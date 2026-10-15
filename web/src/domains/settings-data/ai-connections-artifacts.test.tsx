import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
	createSettingsBackend,
	newCache,
	Screens,
	type SettingsBackend,
} from "./settings.fixture";

const KEY = "sk-test-connection-secret";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});
beforeEach(() => sessionStorage.clear());

function seeded() {
	const backend = createSettingsBackend({ cloud: false });
	const cache = newCache(backend);
	render(<Screens backend={backend} start="ai-connections" cache={cache} />);
	return backend;
}
const saveButton = () =>
	screen.getByRole("button", { name: "設定の変更をすべて保存" });
const applyAll = () =>
	fireEvent.click(
		screen.getByRole("button", { name: "設定の変更をすべて適用" }),
	);
async function review() {
	fireEvent.click(screen.getByRole("button", { name: "変更一覧を開く" }));
}
const lastSent = (backend: SettingsBackend) => backend.sent.at(-1)!.input;

test("each saved connection is its own group, and its fields change by connection id", async () => {
	const backend = seeded();
	fireEvent.click(await screen.findByRole("button", { name: "クラウド音声" }));
	fireEvent.change(screen.getByLabelText("接続名"), {
		target: { value: "名前を変えた接続" },
	});
	fireEvent.click(screen.getByLabelText("この接続を有効にする"));
	fireEvent.click(saveButton());
	await screen.findAllByText("変更を適用しました");
	expect(lastSent(backend)).toMatchObject({
		changes: expect.arrayContaining([
			{
				fieldId: "connection.name",
				target: backend.cloud.connectionId,
				value: "名前を変えた接続",
			},
			{
				fieldId: "connection.enabled",
				target: backend.cloud.connectionId,
				value: "false",
			},
		]),
	});
	expect(backend.saved().connections[0]).toMatchObject({
		name: "名前を変えた接続",
		enabled: false,
	});
});

test("an API key stays in memory: a count in the review, keys in the apply, nothing stored", async () => {
	const backend = seeded();
	fireEvent.click(await screen.findByRole("button", { name: "クラウド音声" }));
	fireEvent.change(screen.getByLabelText("APIキーの更新"), {
		target: { value: KEY },
	});
	// The field never echoes the key: it shows one mark per character.
	expect(screen.getByLabelText("APIキーの更新")).toHaveProperty(
		"value",
		"•".repeat(KEY.length),
	);
	await review();
	await screen.findByText("更新・削除予定 1件");
	expect(document.body.textContent).not.toContain(KEY);
	expect(JSON.stringify({ ...sessionStorage })).not.toContain(KEY);
	applyAll();
	await screen.findAllByText("変更を適用しました");
	expect(lastSent(backend)).toMatchObject({
		keys: [{ connectionId: backend.cloud.connectionId, value: KEY }],
	});
	expect(sessionStorage.length).toBe(0);
	// The key left the draft once it was sent.
	expect(screen.queryByText(/更新・削除予定/)).toBeNull();
});

test("typing a key one character at a time builds the secret; deleting from the end shortens it", async () => {
	const backend = seeded();
	fireEvent.click(await screen.findByRole("button", { name: "クラウド音声" }));
	const box = () => screen.getByLabelText("APIキーの更新") as HTMLInputElement;
	let shown = "";
	for (const ch of "sk-ab") {
		fireEvent.change(box(), { target: { value: shown + ch } });
		shown = box().value;
		expect(shown).toBe("•".repeat(shown.length));
	}
	expect(box().value).toBe("•••••");
	fireEvent.change(box(), { target: { value: "••••" } });
	await review();
	await screen.findByText("更新・削除予定 1件");
	applyAll();
	await screen.findAllByText("変更を適用しました");
	expect(lastSent(backend)).toMatchObject({
		keys: [{ connectionId: backend.cloud.connectionId, value: "sk-a" }],
	});
});

test("emptying the key field keeps the stored key instead of deleting it", async () => {
	const backend = seeded();
	fireEvent.click(await screen.findByRole("button", { name: "クラウド音声" }));
	fireEvent.change(screen.getByLabelText("APIキーの更新"), {
		target: { value: KEY },
	});
	fireEvent.change(screen.getByLabelText("APIキーの更新"), {
		target: { value: "" },
	});
	expect(saveButton()).toHaveProperty("disabled", true);
	expect(backend.sent).toHaveLength(0);
});

test("a changed LARM origin needs the user's confirmation and is sent as a structural confirm", async () => {
	const backend = seeded();
	const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
	fireEvent.change(await screen.findByLabelText("LARMのURL"), {
		target: { value: "http://127.0.0.1:9100" },
	});
	fireEvent.click(saveButton());
	await screen.findAllByText("変更を適用しました");
	expect(confirm).toHaveBeenCalledOnce();
	expect(lastSent(backend)).toMatchObject({
		structural: [
			{
				structure: "structure:settings.confirm-larm-origin@1",
				input: { origin: "http://127.0.0.1:9100" },
			},
		],
	});
	expect(backend.confirmedOrigins).toEqual(["http://127.0.0.1:9100"]);
});

test("declining the origin confirmation applies nothing and keeps the draft", async () => {
	const backend = seeded();
	vi.spyOn(window, "confirm").mockReturnValue(false);
	fireEvent.change(await screen.findByLabelText("LARMのURL"), {
		target: { value: "http://127.0.0.1:9100" },
	});
	fireEvent.click(saveButton());
	await screen.findAllByText(/確認しなかったため適用していません/);
	expect(backend.sent).toHaveLength(0);
	expect(screen.getByLabelText("LARMのURL")).toHaveProperty(
		"value",
		"http://127.0.0.1:9100",
	);
});

test("a path on the same origin needs no confirmation", async () => {
	const backend = seeded();
	const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
	fireEvent.change(await screen.findByLabelText("LARMのURL"), {
		target: { value: "http://127.0.0.1:9001/v2" },
	});
	fireEvent.click(saveButton());
	await screen.findAllByText("変更を適用しました");
	expect(confirm).not.toHaveBeenCalled();
	expect(lastSent(backend)).not.toHaveProperty("structural");
});

test("registering a connection stages it with the key in memory; the apply carries it first", async () => {
	const backend = seeded();
	const form = await screen.findByRole("form", { name: "クラウドAPIを登録" });
	const inputs = form.querySelectorAll("input");
	fireEvent.change(inputs[0]!, { target: { value: "追加する接続" } });
	fireEvent.change(inputs[1]!, {
		target: { value: "https://example.test/v1" },
	});
	fireEvent.change(inputs[2]!, { target: { value: KEY } });
	fireEvent.submit(form);
	await review();
	await screen.findByText("クラウドAPIを登録（追加する接続）");
	await screen.findByText("更新・削除予定 1件");
	expect(document.body.textContent).not.toContain(KEY);
	applyAll();
	await screen.findAllByText("変更を適用しました");
	const sent = lastSent(backend) as {
		structural: Array<{ structure: string; input: { connectionId: string } }>;
		keys: Array<{ connectionId: string; value: string }>;
	};
	expect(sent.structural[0]).toMatchObject({
		structure: "structure:settings.add-connection@1",
		input: { name: "追加する接続", baseUrl: "https://example.test/v1" },
	});
	// The key belongs to the element the host created; nothing but the id links them.
	expect(sent.keys).toEqual([
		{ connectionId: sent.structural[0]!.input.connectionId, value: KEY },
	]);
	expect(sessionStorage.length).toBe(0);
	expect(backend.saved().connections.map((c) => c.name)).toContain(
		"追加する接続",
	);
});

test("deleting a connection is staged after a confirmation and applied with the draft", async () => {
	const backend = seeded();
	const row = (
		await screen.findAllByRole("button", { name: /^接続を削除/ })
	)[0]!;
	fireEvent.click(row);
	fireEvent.click(await screen.findByRole("button", { name: "実行する" }));
	// The dialog closes once the host has taken the action.
	await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
	await review();
	await screen.findByText(/接続を削除/);
	expect(backend.sent).toHaveLength(0);
	applyAll();
	await screen.findAllByText("変更を適用しました");
	expect(lastSent(backend)).toMatchObject({
		structural: [
			{
				structure: "structure:settings.delete-connection@1",
				input: { connectionId: backend.cloud.connectionId },
			},
		],
	});
	expect(backend.saved().connections).toHaveLength(0);
	void waitFor;
	void within;
});

test("discarding the draft takes staged operations and their keys back", async () => {
	seeded();
	const form = await screen.findByRole("form", { name: "クラウドAPIを登録" });
	const inputs = form.querySelectorAll("input");
	fireEvent.change(inputs[0]!, { target: { value: "やめる接続" } });
	fireEvent.change(inputs[1]!, {
		target: { value: "https://example.test/v1" },
	});
	fireEvent.change(inputs[2]!, { target: { value: KEY } });
	fireEvent.submit(form);
	await review();
	await screen.findByText("クラウドAPIを登録（やめる接続）");
	fireEvent.click(
		screen.getByRole("button", { name: "未適用の設定変更をすべて破棄" }),
	);
	await waitFor(() =>
		expect(screen.queryByText(/クラウドAPIを登録（/)).toBeNull(),
	);
	expect(screen.queryByText(/更新・削除予定/)).toBeNull();
});

test("the stored key can be deleted with its own switch; the review counts it as a deletion", async () => {
	const backend = seeded();
	fireEvent.click(await screen.findByRole("button", { name: "クラウド音声" }));
	fireEvent.click(screen.getByLabelText("キーを削除"));
	expect(screen.getByLabelText("キーを削除")).toHaveProperty("checked", true);
	await review();
	await screen.findByText("削除予定 1件");
	expect(screen.queryByText(/更新・削除予定/)).toBeNull();
	applyAll();
	await screen.findAllByText("変更を適用しました");
	expect(lastSent(backend)).toMatchObject({
		keys: [{ connectionId: backend.cloud.connectionId, delete: true }],
	});
});

test("typing a new key replaces a pending deletion, and switching it off takes the deletion back", async () => {
	const backend = seeded();
	fireEvent.click(await screen.findByRole("button", { name: "クラウド音声" }));
	fireEvent.click(screen.getByLabelText("キーを削除"));
	fireEvent.change(screen.getByLabelText("APIキーの更新"), {
		target: { value: KEY },
	});
	expect(screen.getByLabelText("キーを削除")).toHaveProperty("checked", false);
	await review();
	await screen.findByText("更新・削除予定 1件");
	fireEvent.click(screen.getByText("開く:ai-connections"));
	fireEvent.click(await screen.findByRole("button", { name: "クラウド音声" }));
	fireEvent.click(screen.getByLabelText("キーを削除"));
	fireEvent.click(screen.getByLabelText("キーを削除"));
	expect(backend.sent).toHaveLength(0);
	expect(saveButton()).toHaveProperty("disabled", true);
});

test("refusals of a connection apply are explained in words", async () => {
	const backend = seeded();
	fireEvent.click(await screen.findByRole("button", { name: "クラウド音声" }));
	for (const [code, text] of [
		[
			"credential_required",
			"認証情報が必要です。APIキー認証ではAPIキーか環境変数名、サブスクリプションでは setup-token のトークンを入力してください。",
		],
		["auth_required", "Claude Agent SDKの接続には認証方式の指定が必要です。"],
		[
			"invalid_billing_path_change",
			"使用中のモデルがある接続の認証方式は変更できません。新しい接続を登録して、モデルを選び直してください。",
		],
		["connection_exists", "同じ接続がすでに登録されています。"],
		[
			"invalid_origin_requires_new_key",
			"接続先のオリジンを変えるときは、新しいAPIキーを入力してください。",
		],
		[
			"invalid_env_ref_host_conflict",
			"この環境変数は、同じ接続先ホストの別の接続で使われています。",
		],
	] as const) {
		backend.client.submitToolchainAction.mockResolvedValueOnce({
			httpStatus: 200,
			view: {
				eventId: crypto.randomUUID(),
				status: "rejected",
				errorCode: code,
				createdAt: new Date().toISOString(),
			},
		});
		fireEvent.change(screen.getByLabelText("接続名"), {
			target: { value: `名前-${code}` },
		});
		fireEvent.click(saveButton());
		await screen.findAllByText(new RegExp(text));
	}
});
