import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { ApiError } from "../../../../../client";
import type {
	ClaimDetail,
	ClaimRow,
	ForgetView,
} from "../../../../../api/domains/world/contracts";
import { WorldPanel } from "./WorldPanel";

const caches: QueryClient[] = [];
afterEach(() => {
	cleanup();
	for (const cache of caches.splice(0)) cache.clear();
});

const row = (over: Partial<ClaimRow> & { id: string }): ClaimRow => ({
	revision: 2,
	target: { subjectId: "svc-1" },
	claim: {
		predicate: "available",
		content: { kind: "value", value: { kind: "boolean", value: true } },
	},
	adoption: "adopted",
	origin: "user_report",
	evidenceKinds: ["user_statement"],
	freshness: "fresh",
	tone: "adopted",
	...over,
});
const report = row({ id: "claim-report" });
const hypothesis = row({
	id: "claim-hyp",
	origin: "model_hypothesis",
	evidenceKinds: ["assistant_summary"],
	tone: "hypothesis",
	claim: {
		predicate: "launch",
		content: { kind: "value", value: { kind: "string", value: "9月" } },
	},
});
const measured = row({
	id: "claim-measured",
	origin: "runtime_observation",
	evidenceKinds: ["runtime_measurement"],
	tone: "measured",
	freshness: "stale",
	claim: {
		predicate: "latency",
		content: {
			kind: "value",
			value: { kind: "number", value: 120, unit: "ms" },
		},
	},
});
const candidate = row({
	id: "claim-cand",
	revision: 1,
	adoption: "candidate",
	tone: "candidate",
	freshness: "unknown",
	claim: {
		predicate: "price",
		content: { kind: "value", value: { kind: "string", value: "無料" } },
	},
});
const rows = [report, hypothesis, measured, candidate];

const detailOf = (claim: ClaimRow, revision = claim.revision): ClaimDetail => ({
	claim: { ...claim, revision },
	scopeKey: "profile:owner",
	asOf: 1,
	recordedAt: 1,
	condition: {
		kind: "unspecified",
		text: "条件は記述されていません",
		evaluation: "unknown",
		reasons: ["UNSPECIFIED_CONDITION"],
	},
	supports: [
		{
			evidenceId: "ev-1",
			kind: "user_statement",
			stance: "supports",
			source: {
				namespace: "conversation",
				kind: "message",
				id: "m1",
				revision: "sha256:abcdef0123456789",
			},
			rootEvidenceId: "root-1",
		},
	],
	refutations: { evidence: [], claims: [] },
	sources: [
		{
			namespace: "conversation",
			kind: "message",
			id: "m1",
			citedRevision: "sha256:abcdef0123456789",
			state: "current",
		},
	],
	history: [
		{
			revision,
			lifecycle: "active",
			origin: claim.origin,
			recordedAt: 1,
			content: claim.claim.content,
		},
	],
	historyTruncated: false,
});

const forgetView = (over: Partial<ForgetView> = {}): ForgetView => ({
	forgetId: "f-1",
	display: "pending",
	state: "pending",
	blocked: null,
	abandoned: { parts: 0, roots: 0 },
	origin: "request",
	rootCount: 1,
	createdAt: 1_791_500_000_000,
	updatedAt: 1_791_500_000_000,
	...over,
});

type Scenario = {
	status?: Partial<{
		enabled: boolean;
		usable: boolean;
		scopes: { scopeKey: string }[];
	}>;
	items?: ClaimRow[];
	forgets?: ForgetView[];
};
function setup(scenario: Scenario = {}) {
	const state = {
		items: scenario.items ?? rows,
		forgets: scenario.forgets ?? [],
	};
	const status = {
		mode: "on" as const,
		enabled: true,
		usable: true,
		gateOpen: true,
		scopes: [{ scopeKey: "profile:owner" }],
		...scenario.status,
	};
	const client = {
		identity: "world-test",
		replayAudio: vi.fn(),
		conversation: vi.fn(async () => ({
			id: "main",
			revision: 1,
			messages: [
				{
					id: "m1",
					conversationId: "main",
					role: "user" as const,
					text: "音声サービスは9月から",
					createdAt: "2026-10-09T00:00:00.000Z",
					runId: null,
				},
				{
					id: "m2",
					conversationId: "main",
					role: "user" as const,
					text: "いいえ10月からです",
					createdAt: "2026-10-09T00:01:00.000Z",
					runId: null,
				},
				{
					id: "a1",
					conversationId: "main",
					role: "assistant" as const,
					text: "アシスタントの返答",
					createdAt: "2026-10-09T00:02:00.000Z",
					runId: null,
				},
			],
		})),
		worldStatus: vi.fn(async () => status),
		worldClaims: vi.fn(async (scopeKey?: string) => ({
			scopeKey: scopeKey ?? "profile:owner",
			scopes: status.scopes,
			asOf: 1,
			complete: true,
			stopped: 0,
			items: state.items,
		})),
		worldClaim: vi.fn(async (id: string) => {
			const found = state.items.find((r) => r.id === id);
			if (!found) throw new ApiError(404, "not_found");
			return detailOf(found);
		}),
		worldForgets: vi.fn(async (scopeKey?: string) => ({
			scopeKey: scopeKey ?? "profile:owner",
			forgets: state.forgets,
		})),
		correctWorldClaim: vi.fn(),
		retractWorldClaim: vi.fn(),
		forgetWorldClaim: vi.fn(),
	};
	const cache = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	caches.push(cache);
	render(
		<QueryClientProvider client={cache}>
			<WorldPanel client={client as never} />
		</QueryClientProvider>,
	);
	return { client, state };
}
const openDrawer = async (name: RegExp) => {
	fireEvent.click(await screen.findByRole("button", { name }));
	return screen.findByRole("dialog");
};

test("World OFF (status 404): says so and asks for nothing else", async () => {
	const client = {
		identity: "off",
		conversation: vi.fn(async () => ({
			id: "main",
			revision: 1,
			messages: [],
		})),
		worldStatus: vi.fn(async () => {
			throw new ApiError(404, "HTTP 404");
		}),
		worldClaims: vi.fn(),
		worldClaim: vi.fn(),
		worldForgets: vi.fn(),
	};
	const cache = new QueryClient();
	caches.push(cache);
	render(
		<QueryClientProvider client={cache}>
			<WorldPanel client={client as never} />
		</QueryClientProvider>,
	);
	await screen.findByText(/Worldはこの環境でオフ/);
	expect(client.worldClaims).not.toHaveBeenCalled();
	expect(client.worldForgets).not.toHaveBeenCalled();
});

test("protect (World not ON): no list, no corrections; forgets are still shown honestly", async () => {
	const { client } = setup({
		status: { enabled: false, usable: false },
		forgets: [forgetView({ display: "awaiting_confirmation" })],
	});
	await screen.findByText(/Worldは現在オフです/);
	expect(client.worldClaims).not.toHaveBeenCalled();
	expect(screen.queryByRole("table")).toBeNull();
	await screen.findByText(/外部の削除の確認待ち（完了ではありません）/);
});

test("the list keeps target, claim, adoption, evidence and freshness in separate columns", async () => {
	setup();
	const table = await screen.findByRole("table");
	const headers = within(table)
		.getAllByRole("columnheader")
		.map((h) => h.textContent);
	expect(headers.slice(0, 5)).toEqual([
		"対象",
		"主張",
		"採用状態",
		"根拠の種類",
		"鮮度",
	]);
	const line = (id: string) =>
		within(table)
			.getByRole("button", { name: new RegExp(id) })
			.closest("tr") as HTMLElement;
	const cells = (tr: HTMLElement) =>
		Array.from(tr.querySelectorAll("th,td")).map((c) => c.textContent);
	expect(cells(line("svc-1 available"))[0]).toBe("svc-1");
	expect(cells(line("svc-1 available"))[1]).toContain("available");
	expect(cells(line("svc-1 available"))[2]).toContain("採用");
	expect(cells(line("svc-1 available"))[3]).toContain("本人の報告");
	expect(cells(line("svc-1 available"))[4]).toBe("新しい");
});

test("hypothesis, measured, candidate are never in the confirmed style", async () => {
	setup();
	const table = await screen.findByRole("table");
	const tr = (predicate: string) =>
		within(table)
			.getByRole("button", { name: new RegExp(predicate) })
			.closest("tr") as HTMLElement;
	expect(tr("available").className).toContain("world-tone-adopted");
	for (const [predicate, tone, words] of [
		["launch", "hypothesis", "仮説（採用しても未確認）"],
		["latency", "measured", "実測（採用済み）"],
		["price", "candidate", "候補（未採用）"],
	] as const) {
		const line = tr(predicate);
		expect(line.className).toContain(`world-tone-${tone}`);
		expect(line.className).not.toContain("world-tone-adopted");
		expect(within(line).getAllByText(words).length).toBeGreaterThan(0);
	}
	// The confirmed row carries no badge at all.
	expect(tr("available").querySelector(".world-badge")).toBeNull();
});

test("the drawer shows conditions, support, refutation, source versions and history", async () => {
	setup();
	const drawer = await openDrawer(/svc-1 available の詳細/);
	await within(drawer).findByText("条件は記述されていません", { exact: false });
	expect(within(drawer).getByText(/観測がそろうまで未確認/)).toBeTruthy();
	expect(
		within(drawer).getByRole("region", { name: "支持する根拠" }),
	).toBeTruthy();
	expect(
		within(within(drawer).getByRole("region", { name: "反証" })).getByText(
			"なし",
		),
	).toBeTruthy();
	expect(within(drawer).getByText(/現在の版/)).toBeTruthy();
	expect(
		within(within(drawer).getByRole("region", { name: "履歴" })).getAllByRole(
			"listitem",
		),
	).toHaveLength(1);
});

test("a correction carries the revision shown and the chosen statement; success reloads the list", async () => {
	const { client, state } = setup();
	client.correctWorldClaim.mockImplementation(async () => {
		state.items = state.items.map((r) =>
			r.id === "claim-report" ? { ...r, revision: 4 } : r,
		);
		return { status: "applied", claimId: "claim-report" };
	});
	const drawer = await openDrawer(/svc-1 available の詳細/);
	await within(drawer).findByText("条件は記述されていません", { exact: false });
	fireEvent.click(within(drawer).getByRole("button", { name: "訂正する" }));
	const send = within(drawer).getByRole("button", { name: "訂正を送る" });
	expect((send as HTMLButtonElement).disabled).toBe(true);
	fireEvent.change(within(drawer).getByLabelText("理由にする、あなたの発言"), {
		target: { value: "m2" },
	});
	fireEvent.change(within(drawer).getAllByLabelText("新しい値")[0]!, {
		target: { value: "10月" },
	});
	fireEvent.click(send);
	await waitFor(() =>
		expect(client.correctWorldClaim).toHaveBeenCalledTimes(1),
	);
	expect(client.correctWorldClaim).toHaveBeenCalledWith(
		expect.objectContaining({
			scopeKey: "profile:owner",
			expectedRevision: 2,
			target: { claimId: "claim-report" },
			reasonMessageId: "m2",
			value: { kind: "string", value: "10月" },
			requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
		}),
	);
	await screen.findByText(/訂正しました/);
	await waitFor(() =>
		expect(client.worldClaims.mock.calls.length).toBeGreaterThan(1),
	);
});

test("only the person's own messages are offered as the reason", async () => {
	setup();
	const drawer = await openDrawer(/svc-1 available の詳細/);
	await within(drawer).findByText("条件は記述されていません", { exact: false });
	fireEvent.click(within(drawer).getByRole("button", { name: "撤回する" }));
	const select = within(drawer).getByLabelText("理由にする、あなたの発言");
	const options = within(select)
		.getAllByRole("option")
		.map((o) => (o as HTMLOptionElement).value);
	expect(options).toEqual(["", "m2", "m1"]);
});

test("a conflict is shown, the claim is reloaded, and nothing is reported as done", async () => {
	const { client, state } = setup();
	client.retractWorldClaim.mockImplementation(async () => {
		// Someone else changed the claim meanwhile.
		state.items = state.items.map((r) =>
			r.id === "claim-report" ? { ...r, revision: 5 } : r,
		);
		throw new ApiError(409, "revision_conflict");
	});
	const drawer = await openDrawer(/svc-1 available の詳細/);
	await within(drawer).findByText("条件は記述されていません", { exact: false });
	fireEvent.click(within(drawer).getByRole("button", { name: "撤回する" }));
	fireEvent.change(within(drawer).getByLabelText("理由にする、あなたの発言"), {
		target: { value: "m2" },
	});
	const claimsBefore = client.worldClaims.mock.calls.length;
	const detailBefore = client.worldClaim.mock.calls.length;
	fireEvent.click(within(drawer).getByRole("button", { name: "撤回を送る" }));
	const alert = await within(drawer).findByRole("alert");
	expect(alert.textContent).toContain("他の操作で変わりました");
	expect(alert.textContent).toContain("最新の内容を読み込みました");
	await waitFor(() => {
		expect(client.worldClaims.mock.calls.length).toBeGreaterThan(claimsBefore);
		expect(client.worldClaim.mock.calls.length).toBeGreaterThan(detailBefore);
	});
	// The drawer now shows the reloaded revision, and still no success message.
	await waitFor(() =>
		expect(within(drawer).getByText("5", { selector: "dd" })).toBeTruthy(),
	);
	expect(screen.queryByText(/撤回しました/)).toBeNull();
	// A second attempt carries the NEW revision.
	client.retractWorldClaim.mockResolvedValueOnce({
		status: "applied",
		claimId: "claim-report",
	});
	fireEvent.click(within(drawer).getByRole("button", { name: "撤回を送る" }));
	await waitFor(() =>
		expect(client.retractWorldClaim).toHaveBeenCalledTimes(2),
	);
	expect(client.retractWorldClaim.mock.calls[1]![0]).toMatchObject({
		expectedRevision: 5,
	});
});

test("an unresolved target lists candidates and applies nothing", async () => {
	const { client } = setup();
	client.retractWorldClaim.mockResolvedValue({
		status: "unresolved",
		candidates: [report, hypothesis],
	});
	const drawer = await openDrawer(/svc-1 available の詳細/);
	await within(drawer).findByText("条件は記述されていません", { exact: false });
	fireEvent.click(within(drawer).getByRole("button", { name: "撤回する" }));
	fireEvent.change(within(drawer).getByLabelText("理由にする、あなたの発言"), {
		target: { value: "m2" },
	});
	fireEvent.click(within(drawer).getByRole("button", { name: "撤回を送る" }));
	const list = await within(drawer).findByRole("list", { name: "候補の主張" });
	expect(within(list).getAllByRole("button")).toHaveLength(2);
	expect(within(drawer).getByRole("alert").textContent).toContain(
		"何も変更していません",
	);
	expect(screen.queryByText(/撤回しました/)).toBeNull();
	// Picking one only opens it; it is not submitted.
	fireEvent.click(within(list).getAllByRole("button")[1]!);
	await within(screen.getByRole("dialog")).findByText("launch", {
		exact: false,
	});
	expect(client.retractWorldClaim).toHaveBeenCalledTimes(1);
});

test("forget needs a confirmation and is reported as accepted, not as done", async () => {
	const { client, state } = setup();
	client.forgetWorldClaim.mockImplementation(async () => {
		state.forgets = [forgetView({ display: "pending", state: "journaled" })];
		return { status: "accepted", forget: state.forgets[0] };
	});
	const drawer = await openDrawer(/svc-1 price の詳細/);
	await within(drawer).findByText("条件は記述されていません", { exact: false });
	fireEvent.click(within(drawer).getByRole("button", { name: "忘れる" }));
	const start = within(drawer).getByRole("button", {
		name: "忘れる手続きを始める",
	});
	expect((start as HTMLButtonElement).disabled).toBe(true);
	fireEvent.click(within(drawer).getByRole("checkbox"));
	fireEvent.click(start);
	await waitFor(() => expect(client.forgetWorldClaim).toHaveBeenCalledTimes(1));
	expect(client.forgetWorldClaim.mock.calls[0]![0]).toMatchObject({
		expectedRevision: 1,
		target: { claimId: "claim-cand" },
	});
	const status = await screen.findByRole("status");
	expect(status.textContent).toContain("完了ではありません");
	const section = await screen.findByRole("region", { name: "忘却の状況" });
	await within(section).findByText("処理中（完了ではありません）");
	expect(within(section).queryByText("完了")).toBeNull();
});

test("forget states: pending, awaiting confirmation, abandoned are never complete; only complete is", async () => {
	setup({
		forgets: [
			forgetView({ forgetId: "a", display: "pending" }),
			forgetView({ forgetId: "b", display: "awaiting_confirmation" }),
			forgetView({
				forgetId: "c",
				display: "abandoned",
				state: "complete",
				abandoned: { parts: 1, roots: 0 },
			}),
			forgetView({ forgetId: "d", display: "complete", state: "complete" }),
		],
	});
	const section = await screen.findByRole("region", { name: "忘却の状況" });
	const items = within(section).getAllByRole("listitem");
	expect(items).toHaveLength(4);
	const texts = items.map((li) => li.textContent ?? "");
	expect(texts.filter((t) => /完了ではありません/.test(t))).toHaveLength(3);
	expect(texts.filter((t) => t.startsWith("完了"))).toHaveLength(1);
	expect(texts[2]).toContain("実行できなかった範囲 1 件");
});

test("when the list is closed by an unfinished forget, it says so; otherwise it does not guess why", async () => {
	const closed = setup({ forgets: [forgetView()] });
	closed.client.worldClaims.mockRejectedValue(new ApiError(404, "not_found"));
	fireEvent.click(await screen.findByRole("button", { name: "読み直す" }));
	await screen.findByText(/忘却の処理が終わるまで、一覧を表示できません/);
	cleanup();
	const unknown = setup();
	unknown.client.worldClaims.mockRejectedValue(new ApiError(404, "not_found"));
	fireEvent.click(await screen.findByRole("button", { name: "読み直す" }));
	const alert = await screen.findByRole("alert");
	expect(alert.textContent).toContain("一覧を表示できません");
	expect(alert.textContent).not.toMatch(/権限|隠|存在/);
});

test("Scope switch loads only that Scope and drops the open claim", async () => {
	const { client } = setup({
		status: {
			scopes: [{ scopeKey: "profile:owner" }, { scopeKey: "profile:work" }],
		},
	});
	await screen.findByRole("table");
	await openDrawer(/svc-1 available の詳細/);
	client.worldClaims.mockImplementation(async (scopeKey?: string) => ({
		scopeKey: scopeKey ?? "profile:owner",
		scopes: [{ scopeKey: "profile:owner" }, { scopeKey: "profile:work" }],
		asOf: 1,
		complete: true,
		stopped: 0,
		items: scopeKey === "profile:work" ? [] : rows,
	}));
	fireEvent.change(screen.getByLabelText("Scope"), {
		target: { value: "profile:work" },
	});
	await screen.findByText("表示できる主張はありません。");
	expect(client.worldClaims).toHaveBeenLastCalledWith(
		"profile:work",
		expect.anything(),
	);
	expect(client.worldForgets).toHaveBeenLastCalledWith(
		"profile:work",
		expect.anything(),
	);
	expect(screen.queryByRole("dialog")).toBeNull();
	expect(screen.queryByText("svc-1")).toBeNull();
});

test("a partial read is not shown as 'nothing else exists'", async () => {
	const { client } = setup();
	client.worldClaims.mockResolvedValue({
		scopeKey: "profile:owner",
		scopes: [{ scopeKey: "profile:owner" }],
		asOf: 1,
		complete: false,
		stopped: 2,
		items: [report],
	});
	fireEvent.click(await screen.findByRole("button", { name: "読み直す" }));
	await screen.findByText(/表示がないことは「存在しない」ではありません/);
	await screen.findByText(/利用を止めている主張が2件/);
});

test("the screen is not read aloud: it never touches the audio client", async () => {
	const { client } = setup();
	await screen.findByRole("table");
	await openDrawer(/svc-1 available の詳細/);
	expect(client.replayAudio).not.toHaveBeenCalled();
	expect(document.querySelector("audio")).toBeNull();
});

test("rows already on the screen are dropped when the list can no longer be read (a closed Scope shows nothing stale)", async () => {
	const { client } = setup({ forgets: [forgetView()] });
	await screen.findByRole("table");
	client.worldClaims.mockRejectedValue(new ApiError(404, "not_found"));
	fireEvent.click(screen.getByRole("button", { name: "読み直す" }));
	await screen.findByText(/忘却の処理が終わるまで、一覧を表示できません/);
	expect(screen.queryByRole("table")).toBeNull();
	expect(screen.queryByText("latency", { exact: false })).toBeNull();
});
