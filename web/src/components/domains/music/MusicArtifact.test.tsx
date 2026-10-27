import {
	cleanup,
	render,
	screen,
	waitFor,
	fireEvent,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";
import { MusicArtifact } from "./MusicArtifact";
import { musicArtifactDefinition } from "../../../domains/music/artifact-definition";
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});
const record = (id: string, state = "completed") => ({
	id,
	state,
	title: `楽曲${id}`,
	description: "軽快な曲",
	durationSeconds: 30,
	mime: "audio/mpeg",
	updatedAt: 1,
	createdAt: 1,
});
function setup(
	items = [record("a"), record("b")],
	definition = musicArtifactDefinition("a"),
) {
	vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
	const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
	let count = 0;
	vi.spyOn(URL, "createObjectURL").mockImplementation(
		() => `blob:music-${++count}`,
	);
	const api = {
		musicList: vi.fn(async () => items),
		musicAudio: vi.fn(
			async (_id: string, _signal?: AbortSignal) =>
				new Blob(["fixture"], { type: "audio/mpeg" }),
		),
	};
	const cache = new QueryClient();
	const view = render(
		<QueryClientProvider client={cache}>
			<MusicArtifact client={api as never} definition={definition} />
		</QueryClientProvider>,
	);
	return { ...view, api, cache, revoke };
}
test("JSON composition loads authenticated audio, selects playlist tracks, and releases URLs", async () => {
	const result = setup();
	await waitFor(() =>
		expect(result.container.querySelector("audio")?.getAttribute("src")).toBe(
			"blob:music-1",
		),
	);
	expect(screen.getByRole("button", { name: "再生" })).toBeTruthy();
	fireEvent.click(screen.getByRole("button", { name: "詳細" }));
	expect(
		screen.getByRole("link", { name: "楽曲を保存" }).getAttribute("href"),
	).toBe("blob:music-1");
	fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
	fireEvent.click(screen.getByRole("button", { name: "生成履歴" }));
	fireEvent.click(screen.getByRole("button", { name: /楽曲b.*0:30/ }));
	await waitFor(() =>
		expect(result.container.querySelector("audio")?.getAttribute("src")).toBe(
			"blob:music-2",
		),
	);
	expect(result.api.musicAudio.mock.calls.map((c) => c[0])).toEqual(["a", "b"]);
	expect(result.revoke).toHaveBeenCalledWith("blob:music-1");
	result.unmount();
	expect(result.revoke).toHaveBeenCalledWith("blob:music-2");
});
test("an empty shared studio renders the creation form without requesting audio", async () => {
	const r = setup([], musicArtifactDefinition());
	await screen.findByRole("textbox", { name: "音楽作成プロンプト" });
	expect(
		screen.getByRole("button", { name: "楽曲を生成" }).hasAttribute("disabled"),
	).toBe(false);
	expect(r.api.musicAudio).not.toHaveBeenCalled();
});
test("a newer song updates the shared studio while preserving the same editable creation form", async () => {
	const r = setup([record("a")], musicArtifactDefinition());
	const draft = await screen.findByRole("textbox", {
		name: "音楽作成プロンプト",
	});
	fireEvent.change(draft, { target: { value: "この制作プロンプトを残す" } });
	r.cache.setQueryData(
		["music", "list", "main"],
		[{ ...record("b"), createdAt: 2, updatedAt: 2 }, record("a")],
	);
	await waitFor(() =>
		expect(r.api.musicAudio).toHaveBeenCalledWith("b", expect.any(AbortSignal)),
	);
	expect(screen.getByRole("textbox", { name: "音楽作成プロンプト" })).toBe(
		draft,
	);
	expect((draft as HTMLTextAreaElement).value).toBe("この制作プロンプトを残す");
});
test("same JSON transitions from generating to playable when authorized data updates", async () => {
	const result = setup([record("a", "generating")]);
	await screen.findByText("楽曲を生成しています");
	expect(result.api.musicAudio).not.toHaveBeenCalled();
	result.cache.setQueryData(["music", "list", "main"], [record("a")]);
	await waitFor(() =>
		expect(result.container.querySelector("audio")).not.toBeNull(),
	);
	expect(screen.queryByText("楽曲を生成しています")).toBeNull();
});
test("a conversation-generated song populates the prompt and retains it through completion and reset", async () => {
	const r = setup([], musicArtifactDefinition());
	const prompt = await screen.findByRole("textbox", {
		name: "音楽作成プロンプト",
	});
	const item = {
		...record("a", "generating"),
		prompt: "Gentle orchestral piano at dawn",
	};
	r.cache.setQueryData(["music", "list", "main"], [item]);
	await waitFor(() =>
		expect((prompt as HTMLTextAreaElement).value).toBe(item.prompt),
	);
	expect(screen.getByRole("textbox", { name: "音楽作成プロンプト" })).toBe(
		prompt,
	);
	expect(r.api.musicAudio).not.toHaveBeenCalled();
	r.cache.setQueryData(
		["music", "list", "main"],
		[{ ...item, state: "completed", updatedAt: 2 }],
	);
	await waitFor(() => expect(r.api.musicAudio).toHaveBeenCalled());
	expect((prompt as HTMLTextAreaElement).value).toBe(item.prompt);
	fireEvent.click(screen.getByRole("button", { name: "プロンプトをリセット" }));
	r.cache.setQueryData(
		["music", "list", "main"],
		[{ ...item, state: "completed", updatedAt: 3 }],
	);
	expect((prompt as HTMLTextAreaElement).value).toBe("");
	expect(
		screen.getByRole("button", { name: "楽曲を生成" }).hasAttribute("disabled"),
	).toBe(true);
	fireEvent.click(screen.getByRole("button", { name: "編集内容に戻す" }));
	expect((prompt as HTMLTextAreaElement).value).toBe(item.prompt);
});
test("failed generation does not request audio", async () => {
	const result = setup([record("a", "failed")]);
	await screen.findByRole("alert");
	expect(result.api.musicAudio).not.toHaveBeenCalled();
});
test("Opus download uses its own extension with authenticated audio", async () => {
	const result = setup([{ ...record("a"), mime: "audio/ogg" }]);
	await screen.findByRole("button", { name: "再生" });
	fireEvent.click(screen.getByRole("button", { name: "詳細" }));
	await waitFor(() =>
		expect(
			screen.getByRole("link", { name: "楽曲を保存" }).getAttribute("download"),
		).toBe("楽曲a.opus"),
	);
	expect(result.api.musicAudio.mock.calls[0]?.[0]).toBe("a");
});
test("unknown source never triggers a direct audio request", async () => {
	const result = setup([record("other")]);
	await screen.findByRole("alert");
	expect(result.api.musicAudio).not.toHaveBeenCalled();
});
