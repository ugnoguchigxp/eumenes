import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ArtifactDefinitionV1 } from "../../../../api/domains/capabilities/contracts";
import { createWebAdapterRegistry } from "./registry";
import { ToolchainArtifactHost } from "./ToolchainArtifactHost";

const REV = "artifact:dictionary.screen@1";
const DOC = "document:dictionary@1";
const ADAPTER = "adapter:tts-dictionary@1";
const SECRET = "sk-collection-secret";

const write = (actionId: string, extra: object = {}) => ({
	actionId,
	eventAction: actionId,
	source: "dictionary-list",
	operationId: `dictionary.${actionId}`,
	inputSchemaRef: "builtin:emptyInput",
	effect: "write",
	...extra,
});
const artifact = {
	kind: "artifact",
	id: "dictionary.screen",
	revision: 1,
	title: "読み方辞書",
	defaultVariant: "standard",
	variants: [
		{
			id: "standard",
			label: "標準",
			definition: {
				view: "layout",
				children: [
					{
						view: "collection-workspace",
						source: "dictionary-list",
						title: "辞書",
					},
					{
						view: "collection-workspace",
						source: "stage-list",
						title: "追加予定",
					},
					{
						view: "settings-section",
						source: "dictionary-settings",
						title: "設定",
					},
					{ view: "settings-changes", source: "dictionary-changes" },
				],
			},
		},
	],
	sourceBindings: [
		{
			source: "dictionary-list",
			adapterRef: ADAPTER,
			query: "query:dictionary.list@1",
			target: "none",
			paramsSchemaRef: "schema:dictionary-page@1",
		},
		{
			source: "stage-list",
			adapterRef: ADAPTER,
			query: "query:dictionary.list@1",
			target: "none",
		},
		{
			source: "dictionary-settings",
			adapterRef: ADAPTER,
			query: "query:dictionary.settings@1",
			target: "none",
		},
		{
			source: "dictionary-changes",
			adapterRef: ADAPTER,
			query: "query:dictionary.settings@1",
			target: "none",
		},
	],
	collections: [
		{
			source: "dictionary-list",
			title: "辞書",
			rowKey: "id",
			rowsPath: "items",
			paging: true,
			columns: [
				{ key: "word", label: "単語" },
				{ key: "spoken", label: "読み" },
				{ key: "updatedAt", label: "更新", format: "date" },
			],
			rowActions: [
				{ actionId: "delete", confirm: "この読み方を削除しますか？" },
				{ actionId: "restore", when: { key: "state", in: ["removed"] } },
				{
					actionId: "edit-entry",
					form: {
						fields: [
							{
								fieldId: "spoken",
								label: "読み",
								control: "text",
								required: true,
							},
						],
						prefill: { spoken: "$row.spoken" },
					},
				},
			],
			create: {
				actionId: "save",
				fields: [
					{
						fieldId: "word",
						label: "単語",
						control: "text",
						required: true,
						maxLength: 40,
					},
					{ fieldId: "spoken", label: "読み", control: "text", required: true },
					{
						fieldId: "token",
						label: "合言葉",
						control: "secret",
						confidential: true,
					},
				],
			},
		},
		{
			source: "stage-list",
			title: "追加予定",
			rowKey: "id",
			columns: [{ key: "word", label: "単語" }],
			rowActions: [],
			create: {
				actionId: "stage-add",
				fields: [
					{ fieldId: "name", label: "名前", control: "text", required: true },
					{
						fieldId: "key",
						label: "キー",
						control: "secret",
						confidential: true,
					},
				],
			},
		},
	],
	actionBindings: [
		write("delete", {
			label: "削除",
			rowInput: {
				id: "$row.id",
				expectedSpoken: "$row.spoken",
				reason: { literal: "ui" },
			},
		}),
		write("edit-entry", {
			label: "編集",
			rowInput: { id: "$row.id" },
		}),
		write("restore", { label: "戻す", rowInput: { id: "$row.id" } }),
		write("save", {
			label: "登録",
			confidentialFields: ["token"],
			rowInput: { source: { literal: "form" } },
		}),
		{
			actionId: "stage-add",
			eventAction: "stage-add",
			source: "stage-list",
			inputSchemaRef: "builtin:emptyInput",
			effect: "draft",
			draftAction: "structure",
			structure: "structure:dictionary.add@1",
			label: "項目の追加",
			draftDocument: DOC,
			rowInput: { id: { generate: "uuid" } },
		},
		{
			actionId: "edit",
			eventAction: "settings-edit",
			source: "dictionary-settings",
			inputSchemaRef: "builtin:emptyInput",
			effect: "draft",
			draftAction: "edit",
			draftDocument: DOC,
		},
		{
			actionId: "apply",
			eventAction: "settings-apply",
			source: "dictionary-settings",
			inputSchemaRef: "builtin:emptyInput",
			effect: "write",
			operationId: "dictionary.apply",
			draftDocument: DOC,
		},
		{
			actionId: "apply-changes",
			eventAction: "settings-apply",
			source: "dictionary-changes",
			inputSchemaRef: "builtin:emptyInput",
			effect: "write",
			operationId: "dictionary.apply",
			draftDocument: DOC,
		},
		{
			actionId: "discard",
			eventAction: "settings-discard",
			source: "dictionary-changes",
			inputSchemaRef: "builtin:emptyInput",
			effect: "draft",
			draftAction: "discard",
			draftDocument: DOC,
		},
	],
	fields: [
		{
			fieldId: "dictionary.enabled",
			document: DOC,
			path: "$.enabled",
			label: "辞書を使う",
			control: "toggle",
		},
	],
} as unknown as ArtifactDefinitionV1;

const page = {
	items: [
		{
			id: "w1",
			word: "東京",
			spoken: "とうきょう",
			state: "active",
			updatedAt: "2026-10-14T00:00:00Z",
		},
		{
			id: "w2",
			word: "大阪",
			spoken: "おおさか",
			state: "removed",
			updatedAt: "2026-10-14T01:00:00Z",
		},
	],
	total: 2,
	pageIndex: 0,
	pageSize: 10,
};

function setup() {
	const submit = vi.fn(async (event: { eventId: string; input: unknown }) => ({
		httpStatus: 200,
		view: {
			eventId: event.eventId,
			status: "accepted",
			createdAt: new Date().toISOString(),
			result: {
				version: 1,
				executionId: "e",
				artifactRevisionId: REV,
				outcome: "completed",
				resultRefs: [],
				artifactRefs: [],
			},
		},
	}));
	const client = {
		identity: crypto.randomUUID(),
		toolchainArtifact: vi.fn(async () => ({
			artifact,
			artifactRevisionId: REV,
			digest: "d",
			scopeRef: "scope:main",
		})),
		toolchainArtifacts: vi.fn(async () => []),
		toolchainArtifactSource: vi.fn(
			async (
				_rev: string,
				source: string,
				_t?: string,
				_s?: AbortSignal,
				params?: unknown,
			) =>
				source === "dictionary-list" || source === "stage-list"
					? { revision: 0, data: page, params }
					: { revision: 3, data: { enabled: false } },
		),
		toolchainInteractions: vi.fn(async () => []),
		submitToolchainAction: submit,
		toolchainAction: vi.fn(),
		unsettledToolchainActions: vi.fn(async () => []),
	};
	const cache = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	render(
		<QueryClientProvider client={cache}>
			<ToolchainArtifactHost
				client={client as never}
				adapters={createWebAdapterRegistry([])}
				artifactRevisionId={REV}
				artifactId="tab"
			/>
		</QueryClientProvider>,
	);
	return { client, submit };
}

beforeEach(() => sessionStorage.clear());
afterEach(cleanup);

test("a domain without a Web adapter shows its registered list, with row actions filtered by `when`", async () => {
	setup();
	await screen.findByText("東京");
	expect(screen.getByText("おおさか")).toBeTruthy();
	// "戻す" only for rows whose state is in the registered list; delete asks first.
	expect(screen.getAllByRole("button", { name: /^戻す/ })).toHaveLength(1);
	expect(screen.getAllByRole("button", { name: /^削除/ })).toHaveLength(2);
});

test("a row action sends the registered input built from the row the host holds, after confirmation", async () => {
	const { submit } = setup();
	await screen.findByText("東京");
	fireEvent.click(screen.getByRole("button", { name: "削除: 東京" }));
	expect(submit).not.toHaveBeenCalled();
	fireEvent.click(await screen.findByRole("button", { name: "実行する" }));
	await waitFor(() => expect(submit).toHaveBeenCalledOnce());
	expect(submit.mock.calls[0]![0].input).toEqual({
		id: "w1",
		expectedSpoken: "とうきょう",
		reason: "ui",
	});
	// The list is read again after the settled write.
	await waitFor(() =>
		expect(screen.getAllByText("東京").length).toBeGreaterThan(0),
	);
});

test("a create form sends typed values; a secret leaves the form and never touches the outbox", async () => {
	const { submit } = setup();
	await screen.findByText("東京");
	const form = screen.getByRole("form", { name: "登録" });
	const field = (label: string) =>
		form.querySelector<HTMLInputElement>(
			`input[type=${label === "合言葉" ? "password" : "text"}]`,
		)!;
	void field;
	const inputs = form.querySelectorAll("input");
	fireEvent.change(inputs[0]!, { target: { value: "京都" } });
	fireEvent.change(inputs[1]!, { target: { value: "きょうと" } });
	fireEvent.change(inputs[2]!, { target: { value: SECRET } });
	fireEvent.submit(form);
	await waitFor(() => expect(submit).toHaveBeenCalledOnce());
	expect(submit.mock.calls[0]![0].input).toEqual({
		word: "京都",
		spoken: "きょうと",
		token: SECRET,
		source: "form",
	});
	expect(sessionStorage.length).toBe(0);
	await waitFor(() => expect(inputs[2]!.value).toBe(""));
});

test("a create with a missing required value is refused before anything is sent", async () => {
	const { submit } = setup();
	await screen.findByText("東京");
	fireEvent.submit(screen.getByRole("form", { name: "登録" }));
	await screen.findByText("単語を入力してください。");
	expect(submit).not.toHaveBeenCalled();
});

test("search reads the source again with the table query as params", async () => {
	const { client } = setup();
	await screen.findByText("東京");
	const search = screen.getByLabelText("辞書を検索");
	fireEvent.change(search, { target: { value: "京" } });
	fireEvent.submit(search.closest("form")!);
	await waitFor(() =>
		expect(client.toolchainArtifactSource).toHaveBeenCalledWith(
			REV,
			"dictionary-list",
			undefined,
			expect.anything(),
			{ pageIndex: 0, pageSize: 10, desc: false, q: "京" },
		),
	);
});

test("a structural create is staged in the draft with a host-made id, its secret kept in memory, and applied first", async () => {
	const { submit } = setup();
	await screen.findByText("東京");
	const form = screen.getByRole("form", { name: "項目の追加" });
	const inputs = form.querySelectorAll("input");
	fireEvent.change(inputs[0]!, { target: { value: "新しい項目" } });
	fireEvent.change(inputs[1]!, { target: { value: SECRET } });
	fireEvent.submit(form);
	// The review names the staged operation and counts the secret; it shows no value.
	await screen.findByText("項目の追加（新しい項目）");
	expect(screen.getByText("更新・削除予定 1件")).toBeTruthy();
	expect(document.body.textContent).not.toContain(SECRET);
	expect(submit).not.toHaveBeenCalled();
	fireEvent.click(
		screen.getAllByRole("button", { name: "設定の変更をすべて適用" })[0]!,
	);
	await waitFor(() => expect(submit).toHaveBeenCalledOnce());
	const input = submit.mock.calls[0]![0].input as {
		structural: Array<{
			structure: string;
			input: { id: string; name: string };
		}>;
		keys: Array<{ connectionId: string; value: string }>;
		changes: unknown[];
		expectedRevision: number;
	};
	expect(input.expectedRevision).toBe(3);
	expect(input.structural).toEqual([
		{
			structure: "structure:dictionary.add@1",
			input: {
				id: expect.stringMatching(/^[0-9a-f-]{36}$/),
				name: "新しい項目",
			},
		},
	]);
	expect(input.keys).toEqual([
		{ connectionId: input.structural[0]!.input.id, value: SECRET },
	]);
	expect(sessionStorage.length).toBe(0);
	await waitFor(() => expect(screen.queryByText(/項目の追加（/)).toBeNull());
});

test("a row action with a form opens it prefilled from the row and sends the registered input plus the form values", async () => {
	const { submit } = setup();
	await screen.findByText("東京");
	fireEvent.click(screen.getByRole("button", { name: "編集: 東京" }));
	const dialog = await screen.findByRole("dialog");
	const input = dialog.querySelector("input")!;
	expect(input.value).toBe("とうきょう");
	fireEvent.change(input, { target: { value: "とーきょー" } });
	fireEvent.submit(dialog.querySelector("form")!);
	await waitFor(() => expect(submit).toHaveBeenCalledOnce());
	expect(submit.mock.calls[0]![0].input).toEqual({
		id: "w1",
		spoken: "とーきょー",
	});
	await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});
