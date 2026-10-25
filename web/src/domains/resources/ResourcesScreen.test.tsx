import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { ResourcesScreen } from "./ResourcesScreen";
import {
	jsonResponse,
	queryWrapper,
	stubApi,
	testClient,
} from "./test-support";

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

const everything = [
	{
		uri: "eumenes://music.track/m1",
		kind: "music.track",
		kindLabel: "曲",
		label: "夜のドライブ",
		createdAt: "2026-10-25T01:00:00.000Z",
	},
	{
		uri: "eumenes://image/i1",
		kind: "image",
		kindLabel: "画像",
		label: "決戦前",
		createdAt: "2026-10-24T01:00:00.000Z",
	},
];

function setup() {
	const calls = stubApi({
		"/api/resources*": ({ path }) => {
			const params = new URL(path, "http://x").searchParams;
			const kind = params.get("kind");
			const query = params.get("query");
			return jsonResponse({
				resources: everything.filter(
					(r) =>
						(!kind || r.kind === kind) && (!query || r.label.includes(query)),
				),
			});
		},
	});
	const onOpen = vi.fn();
	const { wrapper } = queryWrapper();
	render(<ResourcesScreen client={testClient} onOpen={onOpen} />, { wrapper });
	const searches = () =>
		calls.map((c) =>
			Object.fromEntries(new URL(c.path, "http://x").searchParams),
		);
	return { onOpen, searches };
}

test("lists every resource, newest first as the API returns them, and a row opens it", async () => {
	const { onOpen } = setup();
	const rows = await screen.findAllByRole("button", { name: /を開く$/ });
	expect(rows.map((r) => r.getAttribute("aria-label"))).toEqual([
		"曲 夜のドライブを開く",
		"画像 決戦前を開く",
	]);
	fireEvent.click(rows[1]!);
	expect(onOpen).toHaveBeenCalledWith("eumenes://image/i1");
});

test("the search text, kind and period narrow the request", async () => {
	const { searches } = setup();
	await screen.findByText("夜のドライブ");
	expect(searches()[0]).toEqual({});

	fireEvent.change(screen.getByRole("searchbox", { name: "生成物を検索" }), {
		target: { value: "夜" },
	});
	await waitFor(() => expect(searches().at(-1)).toEqual({ query: "夜" }));
	await waitFor(() => expect(screen.queryByText("決戦前")).toBeNull());

	fireEvent.change(screen.getByRole("searchbox", { name: "生成物を検索" }), {
		target: { value: "" },
	});
	await screen.findByText("決戦前");
	fireEvent.change(screen.getByRole("combobox", { name: "種類" }), {
		target: { value: "image" },
	});
	await waitFor(() => expect(searches().at(-1)).toEqual({ kind: "image" }));

	fireEvent.change(screen.getByRole("combobox", { name: "期間" }), {
		target: { value: "week" },
	});
	await waitFor(() => {
		const last = searches().at(-1)!;
		expect(last.kind).toBe("image");
		const since = Date.parse(last.since ?? "");
		expect(Date.now() - since).toBeGreaterThan(6.9 * 24 * 3600_000);
		expect(Date.now() - since).toBeLessThan(7.1 * 24 * 3600_000);
	});
});

test("the kinds seen so far stay in the filter after it narrows the list", async () => {
	setup();
	await screen.findByText("夜のドライブ");
	fireEvent.change(screen.getByRole("combobox", { name: "種類" }), {
		target: { value: "image" },
	});
	await waitFor(() => expect(screen.queryByText("夜のドライブ")).toBeNull());
	expect(
		[
			...screen
				.getByRole("combobox", { name: "種類" })
				.querySelectorAll("option"),
		].map((o) => o.textContent),
	).toEqual(["すべての種類", "曲", "画像"]);
});

test("an empty result and a failed request are said so", async () => {
	stubApi({ "/api/resources*": () => jsonResponse({ resources: [] }) });
	const { wrapper } = queryWrapper();
	const first = render(
		<ResourcesScreen client={testClient} onOpen={() => {}} />,
		{
			wrapper,
		},
	);
	await screen.findByText("該当する生成物はありません。");
	first.unmount();
	stubApi({ "/api/resources*": () => jsonResponse({ error: "x" }, 500) });
	render(<ResourcesScreen client={testClient} onOpen={() => {}} />, {
		wrapper: queryWrapper().wrapper,
	});
	await screen.findByRole("alert");
});
