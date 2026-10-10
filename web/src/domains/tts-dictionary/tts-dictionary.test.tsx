import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Entry } from "../../../../api/domains/tts-dictionary/contracts";
import { ApiConnectionError, ApiError } from "../../../../client";
import { TtsDictionaryPanel } from "./index";

const caches: QueryClient[] = [];
const originalHeight = window.innerHeight;
beforeEach(() => {
	// 8 rows per column, 24 per page.
	Object.defineProperty(window, "innerHeight", {
		value: 340 + 8 * 38,
		configurable: true,
	});
});
afterEach(() => {
	cleanup();
	for (const cache of caches.splice(0)) cache.clear();
	Object.defineProperty(window, "innerHeight", {
		value: originalHeight,
		configurable: true,
	});
});

function setup(initial: Entry[], saveError?: unknown) {
	const client = {
		identity: "tts-dictionary-test",
		ttsDictionary: vi.fn(async () => initial),
		saveTtsDictionaryEntry: vi.fn(async () => {
			if (saveError) throw saveError;
			return initial;
		}),
		deleteTtsDictionaryEntry: vi.fn(async () => initial),
	};
	const cache = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	caches.push(cache);
	render(
		<QueryClientProvider client={cache}>
			<TtsDictionaryPanel client={client as never} />
		</QueryClientProvider>,
	);
	return client;
}
const edit = (label: string, value: string) => {
	const input = screen.getByLabelText(label);
	fireEvent.focus(input);
	fireEvent.change(input, { target: { value } });
	return input;
};

test("a 409 on save tells the person the dictionary was reloaded", async () => {
	const client = setup(
		[{ written: "API", spoken: "エーピーアイ" }],
		new ApiError(409, "revision_conflict"),
	);
	await screen.findByDisplayValue("エーピーアイ");
	fireEvent.change(screen.getByLabelText("APIの読み方"), {
		target: { value: "えーぴーあい" },
	});
	fireEvent.blur(screen.getByLabelText("APIの読み方"));
	const alert = await screen.findByRole("alert");
	expect(alert.textContent).toContain("別の場所で変更されています");
	expect(alert.textContent).toContain("最新の登録を読み込みました");
	// The dictionary is fetched again after the failure.
	await waitFor(() => expect(client.ttsDictionary).toHaveBeenCalledTimes(2));
});

test("a duplicate written form in a new row is rejected without calling the API", async () => {
	const client = setup([{ written: "API", spoken: "エーピーアイ" }]);
	await screen.findByDisplayValue("エーピーアイ");
	edit("新規1の文字", "API");
	const spoken = edit("新規1の読み方", "あぴ");
	fireEvent.blur(spoken);
	const alert = await screen.findByRole("alert");
	expect(alert.textContent).toBe("「API」は登録済みです。");
	expect(client.saveTtsDictionaryEntry).not.toHaveBeenCalled();
});

test("a half-filled new row asks for both fields and does not save", async () => {
	const client = setup([]);
	await screen.findByLabelText("新規1の文字");
	const written = edit("新規1の文字", "GPU");
	fireEvent.blur(written);
	const alert = await screen.findByRole("alert");
	expect(alert.textContent).toBe("文字と読み方を入力してください。");
	expect(client.saveTtsDictionaryEntry).not.toHaveBeenCalled();
});

test("entries beyond one page are reached through the pager", async () => {
	const entries = Array.from({ length: 30 }, (_, i) => ({
		written: `語${String(i).padStart(2, "0")}`,
		spoken: `ご${i}`,
	}));
	setup(entries);
	await screen.findByLabelText("語00の文字");
	expect(screen.getByText("30件")).toBeTruthy();
	expect(screen.getByText("1 / 2")).toBeTruthy();
	expect(screen.queryByLabelText("語29の文字")).toBeNull();
	const prev = screen.getByRole("button", { name: "前へ" });
	expect((prev as HTMLButtonElement).disabled).toBe(true);
	fireEvent.click(screen.getByRole("button", { name: "次へ" }));
	await screen.findByLabelText("語29の文字");
	expect(screen.queryByLabelText("語00の文字")).toBeNull();
	expect(screen.getByText("2 / 2")).toBeTruthy();
	expect(
		(screen.getByRole("button", { name: "次へ" }) as HTMLButtonElement)
			.disabled,
	).toBe(true);
	fireEvent.click(screen.getByRole("button", { name: "前へ" }));
	await screen.findByLabelText("語00の文字");
});

test("a server error is described by its code, not as a connection problem", async () => {
	setup(
		[{ written: "API", spoken: "エーピーアイ" }],
		new ApiError(500, "dictionary_write_failed"),
	);
	await screen.findByDisplayValue("エーピーアイ");
	fireEvent.change(screen.getByLabelText("APIの読み方"), {
		target: { value: "えーぴーあい" },
	});
	fireEvent.blur(screen.getByLabelText("APIの読み方"));
	const alert = await screen.findByRole("alert");
	expect(alert.textContent).toBe(
		"エラーが発生しました(コード: dictionary_write_failed)",
	);
	expect(alert.textContent).not.toContain("APIの接続を確認");
});

test("a lost connection on save says the API cannot be reached", async () => {
	setup([{ written: "API", spoken: "エーピーアイ" }], new ApiConnectionError());
	await screen.findByDisplayValue("エーピーアイ");
	fireEvent.change(screen.getByLabelText("APIの読み方"), {
		target: { value: "えーぴーあい" },
	});
	fireEvent.blur(screen.getByLabelText("APIの読み方"));
	const alert = await screen.findByRole("alert");
	expect(alert.textContent).toContain("APIに接続できません");
});
