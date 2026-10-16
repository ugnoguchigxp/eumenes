import {
	ArtifactRenderer,
	compileArtifact,
	compileLang,
	type Snapshot,
} from "@eumenes/artifact-ui";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import bundle from "../../../../api/domains/capabilities/bundles/settings-world.bundle.json";

const artifact = bundle.artifacts[0]!;
const definition = JSON.stringify(artifact.variants[0]!.definition);
function snapshot(count = 12): Snapshot {
	return Object.fromEntries(
		artifact.collections.map((collection) => [
			collection.source,
			{
				kind: "collection",
				revision: 1,
				title: collection.title,
				columns: collection.columns.map(({ key, label }) => ({ key, label })),
				total: collection.source === "world-claims" ? count : 1,
				rows: Array.from(
					{ length: collection.source === "world-claims" ? count : 1 },
					(_, i) => ({
						id: `row-${i + 1}`,
						cells: Object.fromEntries(
							collection.columns.map(({ key }) => [
								key,
								key === "connection"
									? "online"
									: key === "subject"
										? `対象${i + 1}`
										: key === "claim"
											? `主張${i + 1}`
											: `${key}-${i + 1}`,
							]),
						),
						actions: [],
					}),
				),
			},
		]),
	) as Snapshot;
}
afterEach(cleanup);

test("World table compiles, pages and sorts; evidence opens in a modal and closing restores focus", async () => {
	const data = snapshot();
	const compiled = compileArtifact(definition, data);
	expect(compileLang(compiled.lang, data)).toEqual(compiled);
	const dispatch = vi.fn(async () => ({
		status: "accepted" as const,
		message: "",
	}));
	render(
		<ArtifactRenderer
			definition={definition}
			runtime={{ snapshot: data, dispatch }}
		/>,
	);
	fireEvent.mouseDown(screen.getByRole("tab", { name: "主張の一覧" }), {
		button: 0,
		ctrlKey: false,
	});
	const table = screen.getByRole("table", { name: "主張の一覧" });
	expect(
		within(table)
			.getAllByRole("columnheader")
			.map((cell) => cell.textContent),
	).toEqual(["対象 ↕", "主張 ↕", "採用状態 ↕", "由来 ↕", "鮮度 ↕", "詳細"]);
	expect(within(table).getAllByRole("row")).toHaveLength(11);
	expect(screen.queryByText("supports-1")).toBeNull();
	const detail = screen.getByRole("button", {
		name: "主張の一覧: row-1の詳細",
	});
	fireEvent.click(detail);
	const dialog = await screen.findByRole("dialog", {
		name: "主張の一覧の詳細",
	});
	for (const label of [
		"条件",
		"支持する根拠",
		"反証",
		"出典の版",
		"履歴",
		"版",
	])
		expect(within(dialog).getByText(label)).toBeTruthy();
	expect(within(dialog).getByText("supports-1")).toBeTruthy();
	fireEvent.click(within(dialog).getByRole("button", { name: /閉じる$/ }));
	await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
	expect(document.activeElement).toBe(detail);
	fireEvent.click(
		screen.getByRole("button", { name: "主張の一覧の次のページ" }),
	);
	expect(within(table).getByRole("cell", { name: "対象12" })).toBeTruthy();
	expect(within(table).getAllByRole("row")).toHaveLength(3);
	fireEvent.click(within(table).getByRole("button", { name: "対象" }));
	fireEvent.click(within(table).getByRole("button", { name: "対象" }));
	expect(within(table).getAllByRole("row")[1]?.textContent).toContain("対象12");
	// Complete loaded collections use local view state without sending a write or page event.
	expect(dispatch).not.toHaveBeenCalled();
});

test("World searches all loaded detail fields, keeps page size and closes a removed row's modal", async () => {
	const dispatch = vi.fn(async () => ({
		status: "accepted" as const,
		message: "",
	}));
	const view = render(
		<ArtifactRenderer
			definition={definition}
			runtime={{ snapshot: snapshot(), dispatch }}
		/>,
	);
	fireEvent.mouseDown(screen.getByRole("tab", { name: "主張の一覧" }), {
		button: 0,
		ctrlKey: false,
	});
	fireEvent.change(screen.getByLabelText("主張の一覧の表示件数"), {
		target: { value: "25" },
	});
	expect(
		within(screen.getByRole("table", { name: "主張の一覧" })).getAllByRole(
			"row",
		),
	).toHaveLength(13);
	fireEvent.change(
		screen.getByRole("searchbox", { name: "主張の一覧を検索" }),
		{ target: { value: "supports-12" } },
	);
	fireEvent.click(screen.getByRole("button", { name: "検索" }));
	fireEvent.click(
		screen.getByRole("button", { name: "主張の一覧: row-12の詳細" }),
	);
	await screen.findByRole("dialog");
	view.rerender(
		<ArtifactRenderer
			definition={definition}
			runtime={{ snapshot: snapshot(1), dispatch }}
		/>,
	);
	await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
	expect(screen.getByText("検索条件に一致する記録はありません。")).toBeTruthy();
	fireEvent.click(screen.getByRole("button", { name: "検索を解除" }));
	expect(
		within(
			screen.getByRole("table", { name: "主張の一覧" }).closest("section")!,
		).getByText("1件 · 1 / 1ページ"),
	).toBeTruthy();
	expect(
		(screen.getByLabelText("主張の一覧の表示件数") as HTMLSelectElement).value,
	).toBe("25");
});

test("World forgets use the same table with the hold reason in a detail modal", async () => {
	render(
		<ArtifactRenderer
			definition={definition}
			runtime={{
				snapshot: snapshot(),
				dispatch: async () => ({ status: "accepted", message: "" }),
			}}
		/>,
	);
	fireEvent.mouseDown(screen.getByRole("tab", { name: "忘却の状況" }), {
		button: 0,
		ctrlKey: false,
	});
	const table = screen.getByRole("table", { name: "忘却の状況" });
	expect(within(table).queryByText("保留の理由")).toBeNull();
	fireEvent.click(
		screen.getByRole("button", { name: "忘却の状況: row-1の詳細" }),
	);
	const dialog = await screen.findByRole("dialog", {
		name: "忘却の状況の詳細",
	});
	expect(within(dialog).getByText("blocked-1")).toBeTruthy();
});

test("World starts with the document table, pages through the host and shows only a compact status", async () => {
	const data = snapshot();
	const docs = data["world-documents"]!;
	if (docs.kind !== "collection") throw new Error("invalid_fixture");
	docs.total = 984;
	docs.paging = {
		pageIndex: 0,
		pageSize: 10,
		sort: "title",
		desc: false,
		q: "",
	};
	const dispatch = vi.fn(async () => ({
		status: "accepted" as const,
		message: "",
	}));
	const view = render(
		<ArtifactRenderer
			definition={definition}
			runtime={{ snapshot: data, dispatch }}
		/>,
	);
	expect(screen.getByRole("table", { name: "資料" })).toBeTruthy();
	expect(screen.getByText("984件 · 1 / 99ページ")).toBeTruthy();
	expect(screen.queryByText("Worldの状態")).toBeNull();
	expect(
		screen
			.getByRole("status", { name: "World: オンライン" })
			.getAttribute("data-online"),
	).toBe("true");
	fireEvent.click(screen.getByRole("button", { name: "資料の次のページ" }));
	await waitFor(() =>
		expect(dispatch).toHaveBeenCalledWith(
			expect.objectContaining({
				action: "collection-page",
				values: expect.objectContaining({ pageIndex: "1", pageSize: "10" }),
			}),
		),
	);
	const offline = structuredClone(data);
	const status = offline["world-status"]!;
	if (status.kind !== "collection") throw new Error("invalid_fixture");
	status.rows[0]!.cells.connection = "offline";
	view.rerender(
		<ArtifactRenderer
			definition={definition}
			runtime={{ snapshot: offline, dispatch }}
		/>,
	);
	expect(
		screen
			.getByRole("status", { name: "World: オフライン" })
			.getAttribute("data-online"),
	).toBe("false");
	view.rerender(
		<ArtifactRenderer
			definition={definition}
			runtime={{ snapshot: data, dispatch }}
		/>,
	);
	vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
	fireEvent(window, new Event("offline"));
	expect(
		screen.getByRole("status", { name: "World: オフライン" }),
	).toBeTruthy();
	vi.restoreAllMocks();
});
