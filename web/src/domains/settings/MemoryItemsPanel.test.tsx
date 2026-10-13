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
import type { MemoryItemDto } from "../../../../api/domains/memory/contracts";
import { ApiError } from "../../../../client/transport";
import { MemoryItemsPanel } from "./MemoryItemsPanel";

const caches: QueryClient[] = [];
afterEach(() => {
	cleanup();
	for (const cache of caches.splice(0)) cache.clear();
});

const base = {
	kind: "preference",
	semanticKey: "k",
	polarity: "affirmed" as const,
	status: "active",
	origin: "user",
	revision: 3,
	sourceMessageIds: ["m1"],
	validFromMs: null,
	validUntilMs: null,
	validity: null,
};
const tea: MemoryItemDto = {
	...base,
	id: "i1",
	text: "お茶が好き",
	evidence: [{ messageId: "m1", quote: "お茶派なんだ" }],
	capturedBy: "request" as const,
};
const coffee: MemoryItemDto = {
	...base,
	id: "i2",
	kind: "habit",
	text: "朝にコーヒーを飲む",
	polarity: "negated" as const,
	evidence: [{ messageId: "m2", quote: null }],
	validity: { from: "2026-09" },
	capturedBy: "agent" as const,
};
const stopped: MemoryItemDto = {
	...base,
	id: "i3",
	kind: "constraint",
	text: "夜は電話しない",
	status: "inactive",
	evidence: [],
	capturedBy: "manual" as const,
};
const note = {
	id: "n1",
	conversationId: "main",
	kind: "activity" as const,
	text: "Rust移行の調査",
	status: "active" as const,
	revision: 2,
	createdAt: "2026-10-13T00:00:00.000Z",
	updatedAt: "2026-10-13T00:00:00.000Z",
	origin: "agent" as const,
	sourceMessageId: "m1",
	expiresAt: null,
};
const context = {
	version: 7,
	longTerm: { text: "長期の本文です", bytes: 21, limit: 16384 },
	shortTerm: {
		text: "短期の本文です",
		bytes: 30,
		limit: 8192,
		pendingAdditions: 2,
	},
	notices: 1,
};

function setup(
	status = { enabled: true, healthy: true },
	contextResponse: unknown = context,
) {
	const client = {
		identity: "items-test",
		memoryStatus: vi.fn(async () => status),
		memoryItems: vi.fn(async (all = false) =>
			all ? [tea, coffee, stopped] : [tea, coffee],
		),
		memoryAction: vi.fn(async () => tea),
		forgetItem: vi.fn(async () => ({ forgetId: "f1", completed: true })),
		memoryShortTerm: vi.fn(async (_conversationId: string) => [note]),
		continuityTransition: vi.fn(async () => note),
		memoryTendencies: vi.fn(async () => [
			{ id: "t1", text: "朝型", revision: 1, updatedAt: "2026-10-13" },
		]),
		deleteTendency: vi.fn(async () => ({ ok: true as const })),
		memoryContext: vi.fn(
			async (_conversationId: string) => contextResponse as never,
		),
	};
	const cache = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	caches.push(cache);
	const tree = (conversationId: string) => (
		<QueryClientProvider client={cache}>
			<MemoryItemsPanel client={client} conversationId={conversationId} />
		</QueryClientProvider>
	);
	const view = render(tree("main"));
	return {
		client,
		changeConversation: (id: string) => view.rerender(tree(id)),
	};
}
const row = (text: string) =>
	screen.getByText(text).closest("li") as HTMLElement;
const button = (text: string, name: string) =>
	within(row(text)).getByRole("button", { name });

test("lists long-term items with kind, negation, validity, evidence and provenance", async () => {
	setup();
	await screen.findByText("お茶が好き");
	const a = within(row("お茶が好き"));
	a.getByText("好み");
	a.getByText("利用中");
	a.getByText("頼まれて記憶");
	a.getByText("「お茶派なんだ」");
	const b = within(row("「朝にコーヒーを飲む」ではない"));
	b.getByText("習慣");
	b.getByText("会話から自動で記憶");
	b.getByText("元の発言は見つかりません");
	b.getByText("期間: 2026-09〜");
});

test("every state status has a Japanese label and unknown ones are not shown raw", async () => {
	const { client } = setup();
	const labels: [string, string][] = [
		["active", "利用中"],
		["inactive", "停止中"],
		["superseded", "置き換え済み"],
		["disputed", "内容に争いあり"],
		["retracted", "撤回済み"],
		["invalidated", "根拠が失われ無効"],
		["forgotten", "消去済み"],
		["something_new", "不明な状態"],
	];
	client.memoryItems.mockResolvedValue(
		labels.map(([status], i) => ({
			...tea,
			id: `s${i}`,
			text: `状態${i}`,
			status,
		})),
	);
	fireEvent.click(await screen.findByLabelText("履歴も表示"));
	for (const [i, [status, label]] of labels.entries()) {
		await screen.findByText(`状態${i}`);
		within(row(`状態${i}`)).getByText(label);
		expect(
			screen.queryByText(status === "active" ? "never" : status),
		).toBeNull();
	}
});

test("history and the automatic-only filter change what is shown", async () => {
	const { client } = setup();
	await screen.findByText("お茶が好き");
	expect(screen.queryByText("夜は電話しない")).toBeNull();
	fireEvent.click(screen.getByLabelText("履歴も表示"));
	await screen.findByText("夜は電話しない");
	expect(client.memoryItems).toHaveBeenLastCalledWith(true);
	const manual = within(row("夜は電話しない"));
	manual.getByText("手動登録");
	manual.getByText("停止中");
	manual.getByText("元の発言は見つかりません");
	fireEvent.click(screen.getByLabelText("自動で記憶したものだけ"));
	expect(screen.queryByText("お茶が好き")).toBeNull();
	expect(screen.queryByText("夜は電話しない")).toBeNull();
	screen.getByText("「朝にコーヒーを飲む」ではない");
});

test("stop and resume send the displayed revision", async () => {
	const { client } = setup();
	await screen.findByText("お茶が好き");
	fireEvent.click(button("お茶が好き", "「お茶が好き」の利用を止める"));
	await waitFor(() =>
		expect(client.memoryAction).toHaveBeenLastCalledWith("i1", "stop", 3),
	);
	fireEvent.click(screen.getByLabelText("履歴も表示"));
	await screen.findByText("夜は電話しない");
	fireEvent.click(
		button("夜は電話しない", "「夜は電話しない」の利用を再開する"),
	);
	await waitFor(() =>
		expect(client.memoryAction).toHaveBeenLastCalledWith("i3", "resume", 3),
	);
});

test("rapid double clicks run the mutation once and the panel stays busy until the reload ends", async () => {
	const { client } = setup();
	await screen.findByText("お茶が好き");
	let release!: (items: MemoryItemDto[]) => void;
	// the reload that follows the mutation is held back
	client.memoryItems.mockImplementationOnce(
		() =>
			new Promise<MemoryItemDto[]>((resolve) => {
				release = resolve;
			}),
	);
	const stop = button("お茶が好き", "「お茶が好き」の利用を止める");
	fireEvent.click(stop);
	fireEvent.click(stop);
	await waitFor(() => expect(client.memoryAction).toHaveBeenCalledTimes(1));
	await waitFor(() => expect(release).toBeTypeOf("function"));
	expect((stop as HTMLButtonElement).disabled).toBe(true);
	fireEvent.click(stop);
	expect(client.memoryAction).toHaveBeenCalledTimes(1);
	release([tea, coffee]);
	await waitFor(() =>
		expect(
			(
				button(
					"お茶が好き",
					"「お茶が好き」の利用を止める",
				) as HTMLButtonElement
			).disabled,
		).toBe(false),
	);
});

test("forgetting needs a second confirmation and can be cancelled", async () => {
	const { client } = setup();
	await screen.findByText("お茶が好き");
	fireEvent.click(button("お茶が好き", "「お茶が好き」を完全に消す"));
	expect(client.forgetItem).not.toHaveBeenCalled();
	fireEvent.click(button("お茶が好き", "「お茶が好き」の削除をやめる"));
	expect(
		within(row("お茶が好き")).queryByRole("button", {
			name: "「お茶が好き」を本当に完全に消す",
		}),
	).toBeNull();
	fireEvent.click(button("お茶が好き", "「お茶が好き」を完全に消す"));
	fireEvent.click(button("お茶が好き", "「お茶が好き」を本当に完全に消す"));
	await waitFor(() => expect(client.forgetItem).toHaveBeenCalledWith("i1"));
	expect(client.forgetItem).toHaveBeenCalledTimes(1);
});

test("a revision conflict and an incomplete forget show their messages and reload", async () => {
	const { client } = setup();
	await screen.findByText("お茶が好き");
	client.memoryAction.mockRejectedValueOnce(
		new ApiError(409, "revision_conflict"),
	);
	fireEvent.click(button("お茶が好き", "「お茶が好き」の利用を止める"));
	expect((await screen.findByRole("alert")).textContent).toBe(
		"他で変更されました。読み直してください",
	);
	await waitFor(() => expect(client.memoryItems).toHaveBeenCalledTimes(2));
	client.forgetItem.mockRejectedValueOnce(
		new ApiError(409, "memory_forget_incomplete"),
	);
	await waitFor(() =>
		expect(
			(button("お茶が好き", "「お茶が好き」を完全に消す") as HTMLButtonElement)
				.disabled,
		).toBe(false),
	);
	fireEvent.click(button("お茶が好き", "「お茶が好き」を完全に消す"));
	fireEvent.click(button("お茶が好き", "「お茶が好き」を本当に完全に消す"));
	await waitFor(() =>
		expect(screen.getByRole("alert").textContent).toBe(
			"一部だけ消えました。もう一度『完全に消す』を押してください",
		),
	);
});

test("an incomplete forget result is reported even without an error", async () => {
	const { client } = setup();
	client.forgetItem.mockResolvedValueOnce({ forgetId: "f1", completed: false });
	await screen.findByText("お茶が好き");
	fireEvent.click(button("お茶が好き", "「お茶が好き」を完全に消す"));
	fireEvent.click(button("お茶が好き", "「お茶が好き」を本当に完全に消す"));
	expect((await screen.findByRole("alert")).textContent).toContain(
		"一部だけ消えました",
	);
});

test("unhealthy memory hides every list and the context", async () => {
	const { client } = setup({ enabled: true, healthy: false });
	await screen.findByText(/一覧は表示しません/);
	expect(screen.queryByText("お茶が好き")).toBeNull();
	expect(screen.queryByText("朝型")).toBeNull();
	expect(screen.queryByText("最近の活動・メモ（短期）")).toBeNull();
	expect(screen.queryByText("いまの文脈")).toBeNull();
	expect(client.memoryItems).not.toHaveBeenCalled();
	expect(client.memoryShortTerm).not.toHaveBeenCalled();
	expect(client.memoryTendencies).not.toHaveBeenCalled();
	expect(client.memoryContext).not.toHaveBeenCalled();
});

test("a failed status read hides every list", async () => {
	const { client } = setup();
	cleanup();
	client.memoryStatus.mockRejectedValue(new Error("offline"));
	const cache = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	caches.push(cache);
	render(
		<QueryClientProvider client={cache}>
			<MemoryItemsPanel client={client} conversationId="main" />
		</QueryClientProvider>,
	);
	await screen.findByText(/接続状態を確認できないため/);
	expect(screen.queryByText("お茶が好き")).toBeNull();
	expect(screen.queryByText("いまの文脈")).toBeNull();
	expect(client.memoryItems).not.toHaveBeenCalled();
});

test("disconnected but healthy memory still lists items and explains the empty context", async () => {
	setup({ enabled: false, healthy: true }, { disabled: true });
	await screen.findByText("お茶が好き");
	await screen.findByText(/文脈は組み立てていません/);
	screen.getByText("Rust移行の調査");
	expect(screen.queryByText(/版 /)).toBeNull();
});

test("short-term notes can be completed or cancelled with their revision", async () => {
	const { client } = setup();
	await screen.findByText("Rust移行の調査");
	const complete = () =>
		button("Rust移行の調査", "「Rust移行の調査」を完了にする");
	within(row("Rust移行の調査")).getByText("活動");
	fireEvent.click(complete());
	await waitFor(() =>
		expect(client.continuityTransition).toHaveBeenLastCalledWith(
			"n1",
			"resolved",
			2,
		),
	);
	await waitFor(() => expect(complete().hasAttribute("disabled")).toBe(false));
	fireEvent.click(button("Rust移行の調査", "「Rust移行の調査」を取り消す"));
	await waitFor(() =>
		expect(client.continuityTransition).toHaveBeenLastCalledWith(
			"n1",
			"retracted",
			2,
		),
	);
});

test("a short-term conflict is shown in the short-term section", async () => {
	const { client } = setup();
	await screen.findByText("Rust移行の調査");
	client.continuityTransition.mockRejectedValueOnce(
		new ApiError(409, "revision_conflict"),
	);
	fireEvent.click(button("Rust移行の調査", "「Rust移行の調査」を完了にする"));
	const alert = await screen.findByRole("alert");
	expect(alert.textContent).toBe("他で変更されました。読み直してください");
	expect(
		within(
			screen.getByText("最近の活動・メモ（短期）").parentElement
				?.parentElement as HTMLElement,
		).getByRole("alert"),
	).toBe(alert);
	await waitFor(() => expect(client.memoryShortTerm).toHaveBeenCalledTimes(2));
});

test("tendencies are listed and deleting needs a second confirmation", async () => {
	const { client } = setup();
	await screen.findByText("朝型");
	fireEvent.click(button("朝型", "傾向「朝型」を削除"));
	expect(client.deleteTendency).not.toHaveBeenCalled();
	fireEvent.click(button("朝型", "傾向「朝型」の削除をやめる"));
	expect(client.deleteTendency).not.toHaveBeenCalled();
	fireEvent.click(button("朝型", "傾向「朝型」を削除"));
	fireEvent.click(button("朝型", "傾向「朝型」を本当に削除"));
	await waitFor(() => expect(client.deleteTendency).toHaveBeenCalledWith("t1"));
	expect(client.deleteTendency).toHaveBeenCalledTimes(1);
});

test("the current context shows sizes, version and collapsible texts and reloads on demand", async () => {
	const { client } = setup();
	await screen.findByText("版 7");
	screen.getByText("長期: 21 / 16384 byte");
	screen.getByText("短期: 30 / 8192 byte （追加待ち 2 件）");
	screen.getByText("次の会話で伝える通知: 1 件");
	screen.getByText("長期の本文です");
	screen.getByText("短期の本文です");
	expect(document.querySelectorAll("details").length).toBe(2);
	fireEvent.click(screen.getByRole("button", { name: "読み直す" }));
	await waitFor(() => expect(client.memoryContext).toHaveBeenCalledTimes(2));
});

test("a disabled context is explained instead of shown", async () => {
	setup({ enabled: true, healthy: true }, { disabled: true });
	await screen.findByText(/文脈は組み立てていません/);
	expect(screen.queryByText(/版 /)).toBeNull();
});

test("changing the conversation re-reads short-term notes and context with the new id", async () => {
	const { client, changeConversation } = setup();
	await screen.findByText("版 7");
	expect(client.memoryShortTerm).toHaveBeenLastCalledWith("main");
	changeConversation("other");
	await waitFor(() =>
		expect(client.memoryShortTerm).toHaveBeenLastCalledWith("other"),
	);
	await waitFor(() =>
		expect(client.memoryContext).toHaveBeenLastCalledWith("other"),
	);
});
