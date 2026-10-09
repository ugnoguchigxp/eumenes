import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { MemoryConnectionPanel } from "./MemoryConnectionPanel";

const caches: QueryClient[] = [];
afterEach(() => {
	cleanup();
	for (const cache of caches.splice(0)) cache.clear();
});
function setup(initial = { enabled: true, healthy: true }) {
	let saved = initial;
	const client = {
		identity: "memory-test",
		memoryStatus: vi.fn(async () => saved),
		setMemoryEnabled: vi.fn(async (enabled: boolean) => {
			saved = { ...saved, enabled };
			return saved;
		}),
	};
	const cache = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	caches.push(cache);
	const view = render(
		<QueryClientProvider client={cache}>
			<MemoryConnectionPanel client={client} />
		</QueryClientProvider>,
	);
	return { client, view };
}

test("disconnects and reconnects using the saved API status", async () => {
	const { client } = setup();
	fireEvent.click(
		await screen.findByRole("button", { name: "メモリーを切断" }),
	);
	await screen.findByText("非接続");
	expect(client.setMemoryEnabled).toHaveBeenLastCalledWith(false);
	fireEvent.click(screen.getByRole("button", { name: "メモリーを接続" }));
	await screen.findByText("接続中");
	expect(client.setMemoryEnabled).toHaveBeenLastCalledWith(true);
});

test("waits for persistence and blocks duplicate changes while saving", async () => {
	const { client } = setup();
	let finish!: (value: { enabled: boolean; healthy: boolean }) => void;
	client.setMemoryEnabled.mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				finish = resolve;
			}),
	);
	const button = await screen.findByRole("button", { name: "メモリーを切断" });
	fireEvent.click(button);
	await screen.findByText("切り替え中…");
	expect((button as HTMLButtonElement).disabled).toBe(true);
	fireEvent.click(button);
	await waitFor(() => expect(client.setMemoryEnabled).toHaveBeenCalledTimes(1));
	expect(screen.queryByText("非接続")).toBeNull();
	finish({ enabled: false, healthy: true });
	await screen.findByText("非接続");
});

test("a failed save re-reads the server and does not claim disconnection", async () => {
	const { client } = setup();
	client.setMemoryEnabled.mockRejectedValueOnce(new Error("offline"));
	fireEvent.click(
		await screen.findByRole("button", { name: "メモリーを切断" }),
	);
	await screen.findByRole("alert");
	await waitFor(() => expect(client.memoryStatus).toHaveBeenCalledTimes(2));
	await screen.findByText("接続中");
	expect(screen.queryByText("非接続")).toBeNull();
});

test("unhealthy memory is visibly stopped, can be disconnected, and cannot be reconnected", async () => {
	setup({ enabled: true, healthy: false });
	await screen.findByText("利用停止中（接続設定はオン）");
	fireEvent.click(screen.getByRole("button", { name: "メモリーを切断" }));
	const button = await screen.findByRole("button", { name: "メモリーを接続" });
	expect((button as HTMLButtonElement).disabled).toBe(true);
	expect(screen.getByRole("alert").textContent).toContain(
		"現在は利用していません",
	);
});

test("read failures hide stale controls and support recovery", async () => {
	const { client } = setup();
	await screen.findByText("接続中");
	client.memoryStatus.mockRejectedValueOnce(new Error("offline"));
	fireEvent.click(screen.getByRole("button", { name: "接続状態を読み直す" }));
	await screen.findByText("接続状態を確認できません");
	expect(screen.queryByRole("button", { name: "メモリーを切断" })).toBeNull();
	fireEvent.click(screen.getByRole("button", { name: "接続状態を読み直す" }));
	await screen.findByRole("button", { name: "メモリーを切断" });
});
