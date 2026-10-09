import { afterEach, expect, test, vi } from "vitest";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError, type EumenesClient } from "../../../../client";
import { queryRoots } from "../../queryKeys";
import { ResearchRoutesPanel } from ".";
afterEach(cleanup);
const key = "a".repeat(64);
const summary = {
	key,
	keywords: "天気予報 鎌倉",
	target: { name: "鎌倉市", prefecture: "神奈川県", granularity: "city" },
	state: "active",
	stateToken: "t".repeat(64),
	activeVersionId: "v",
	sourceUrl: "https://example.test/kamakura",
	lastSuccessAt: 1_000,
	draftStatus: { id: "d", state: "rejected", errorCode: "queue_full" },
};
const detail = {
	...summary,
	skillRevision: { revisionId: "r", hash: "h", body: "SKILL_BODY" },
	contextProjection: "CONTEXT_BODY",
};
function setup(overrides: Record<string, unknown> = {}) {
	const client = {
		identity: "routes",
		researchRoutes: vi.fn(async () => ({
			items: [summary],
			nextCursor: null,
			epoch: 4,
		})),
		researchRoute: vi.fn(async () => detail),
		editResearchRoute: vi.fn(async () => ({ draftId: "d2" })),
		disableResearchRoute: vi.fn(async () => ({ ...detail, state: "disabled" })),
		rediscoverResearchRoute: vi.fn(async () => detail),
		clearResearchRoutes: vi.fn(async () => ({ epoch: 5, deletedKeys: 1 })),
		...overrides,
	} as unknown as EumenesClient;
	const cache = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const onDirty = vi.fn();
	render(
		<QueryClientProvider client={cache}>
			<ResearchRoutesPanel client={client} onDirty={onDirty} />
		</QueryClientProvider>,
	);
	return { client, cache, onDirty };
}

test("U01 read: list, detail with SKILL/Context, and a failed draft does not hide the active route", async () => {
	setup();
	fireEvent.click(await screen.findByText("天気予報 鎌倉"));
	await screen.findByText("SKILL_BODY");
	expect(screen.getByText("CONTEXT_BODY")).toBeTruthy();
	expect(screen.getAllByText("利用中").length).toBeGreaterThan(0);
	expect(screen.getAllByText(/登録できませんでした/).length).toBeGreaterThan(0);
});

test("U01 edit marks dirty, sends the state token, and a 409 reloads instead of writing", async () => {
	const edit = vi.fn(async () => {
		throw new ApiError(409, "stale_state_token");
	});
	const { client, onDirty } = setup({ editResearchRoute: edit });
	fireEvent.click(await screen.findByText("天気予報 鎌倉"));
	const box = await screen.findByRole("textbox");
	fireEvent.change(box, { target: { value: "もっと短く" } });
	await waitFor(() => expect(onDirty).toHaveBeenLastCalledWith(true));
	fireEvent.click(screen.getByText("編集を依頼"));
	await screen.findByText(/他の操作で状態が変わりました/);
	expect(edit).toHaveBeenCalledWith(
		key,
		expect.objectContaining({
			expectedStateToken: summary.stateToken,
			instruction: "もっと短く",
		}),
	);
	await waitFor(() =>
		expect(
			(client.researchRoutes as ReturnType<typeof vi.fn>).mock.calls.length,
		).toBeGreaterThan(1),
	);
});

test("U01 disable / rediscover / clear use the persisted tokens and epoch", async () => {
	const { client } = setup();
	fireEvent.click(await screen.findByText("天気予報 鎌倉"));
	fireEvent.click(await screen.findByText("この取得先を停止"));
	await waitFor(() => expect(client.disableResearchRoute).toHaveBeenCalled());
	fireEvent.click(screen.getByText("次回は取得先を探し直す"));
	await waitFor(() =>
		expect(client.rediscoverResearchRoute).toHaveBeenCalled(),
	);
	fireEvent.click(screen.getByText("取得先をすべて削除"));
	fireEvent.click(screen.getByText("削除する"));
	await waitFor(() =>
		expect(client.clearResearchRoutes).toHaveBeenCalledWith(
			expect.objectContaining({ expectedEpoch: 4 }),
		),
	);
	await screen.findByText("1件の取得先を削除しました。");
});

test("U01 a route deleted behind the panel (404) disappears and its cached detail is removed", async () => {
	let gone = false;
	const { cache } = setup({
		researchRoute: vi.fn(async () => {
			if (gone) throw new ApiError(404, "not_found");
			return detail;
		}),
	});
	fireEvent.click(await screen.findByText("天気予報 鎌倉"));
	await screen.findByText("SKILL_BODY");
	gone = true;
	await cache.invalidateQueries({ queryKey: [queryRoots.researchRoutes] });
	await waitFor(() => expect(screen.queryByText("SKILL_BODY")).toBeNull());
	expect(
		cache.getQueryData([queryRoots.researchRoutes, "routes", "detail", key]),
	).toBeUndefined();
});

test("U01 SSE invalidation covers research routes, settings never import the domain, and there is no polling", async () => {
	const { changeRoots } = await import("../../queryKeys");
	expect(changeRoots).toContain(queryRoots.researchRoutes);
	const { readFileSync, readdirSync } = await import("node:fs");
	const dir = "web/src/domains/settings";
	const files = readdirSync(dir, { recursive: true, encoding: "utf8" }).filter(
		(f) => /\.tsx?$/.test(f) && !/\.test\./.test(f),
	);
	for (const f of files)
		expect(readFileSync(`${dir}/${f}`, "utf8")).not.toContain(
			"research-routes",
		);
	expect(
		readFileSync("web/src/domains/research-routes/index.tsx", "utf8"),
	).not.toContain("refetchInterval");
});

const other: typeof summary = {
	...summary,
	key: "b".repeat(64),
	keywords: "株価 AAPL NASDAQ USD regular",
	target: {
		ticker: "AAPL",
		market: "NASDAQ",
		currency: "USD",
		priceKind: "regular",
	} as never,
};

test("U01 an unsent edit survives switching routes and keeps the panel dirty", async () => {
	const { onDirty } = setup({
		researchRoutes: vi.fn(async () => ({
			items: [summary, other],
			nextCursor: null,
			epoch: 4,
		})),
		researchRoute: vi.fn(async (k: string) => ({
			...detail,
			key: k,
			keywords: k === key ? summary.keywords : other.keywords,
		})),
	});
	fireEvent.click(await screen.findByText("天気予報 鎌倉"));
	fireEvent.change(await screen.findByRole("textbox"), {
		target: { value: "未送信の説明" },
	});
	await waitFor(() => expect(onDirty).toHaveBeenLastCalledWith(true));
	fireEvent.click(screen.getByText("株価 AAPL NASDAQ USD regular"));
	await screen.findByLabelText("取得先 株価 AAPL NASDAQ USD regular");
	expect(onDirty).not.toHaveBeenLastCalledWith(false);
	fireEvent.click(screen.getByText("天気予報 鎌倉"));
	expect(
		((await screen.findByRole("textbox")) as HTMLTextAreaElement).value,
	).toBe("未送信の説明");
});

test("U01 a stale cursor (409) on 'more' reloads the list from the first page", async () => {
	let epoch = 4;
	const researchRoutes = vi.fn(
		async (q: { cursor?: string }, _signal?: AbortSignal) => {
			if (q.cursor && epoch !== 4) throw new ApiError(409, "stale_cursor");
			return q.cursor
				? { items: [other], nextCursor: null, epoch }
				: { items: [summary], nextCursor: "c1", epoch };
		},
	);
	setup({ researchRoutes });
	await screen.findByText("天気予報 鎌倉");
	epoch = 5; // another client cleared behind this panel
	fireEvent.click(screen.getByText("さらに表示"));
	await screen.findByText(/最新の状態を読み込みました/);
	await waitFor(() => {
		const calls = researchRoutes.mock.calls;
		expect(calls[calls.length - 1]![0]).toEqual({});
	});
});

test("U01 an SSE change invalidation re-reads the list without polling", async () => {
	let items = [summary];
	const { cache } = setup({
		researchRoutes: vi.fn(async () => ({ items, nextCursor: null, epoch: 4 })),
	});
	await screen.findByText("天気予報 鎌倉");
	items = [summary, other];
	await cache.invalidateQueries({ queryKey: [queryRoots.researchRoutes] });
	await screen.findByText("株価 AAPL NASDAQ USD regular");
});
