import { afterEach, expect, test, vi } from "vitest";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createClient } from "../../../../client";
import type { ServiceCatalog } from "../../../../api/domains/service-tests/contracts";
import { ServiceTestsPanel } from ".";
afterEach(cleanup);
function setup(stale = false, disabled = false) {
	const catalog: ServiceCatalog = {
		targets: [
			{
				id: "image",
				name: "image",
				kind: "image",
				model: "qwen-image",
				capability: "media.image.generate",
				protocol: "larm.image-generation.v1",
				source: "larm",
				onDemand: true,
				primary: true,
				testable: true,
			},
			{
				id: "asr",
				name: "asr",
				kind: "asr",
				model: "qwen-asr",
				capability: "speech.stt",
				protocol: "openai.audio-transcriptions.v1",
				source: "larm",
				onDemand: false,
				primary: true,
				testable: true,
			},
		],
		errors: [],
		discoveredAt: Date.now(),
		revision: 2,
		stale,
	};
	const client = {
		...createClient("http://127.0.0.1:8787"),
		serviceCatalog: vi.fn(async () => catalog),
		serviceRuns: vi.fn(async () => []),
		startServiceTest: vi.fn(),
		refreshServiceCatalog: vi.fn(async () => catalog),
		diagnoseServices: vi.fn(),
	};
	const cache = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	render(
		<QueryClientProvider client={cache}>
			<ServiceTestsPanel client={client} disabled={disabled} />
		</QueryClientProvider>,
	);
	return client;
}
test("selecting services does not execute and sample image has small bounded defaults", async () => {
	const c = setup();
	const go = await screen.findByRole("button", { name: "▶ 画像を生成" });
	expect(c.startServiceTest).not.toHaveBeenCalled();
	expect(c.diagnoseServices).not.toHaveBeenCalled();
	fireEvent.click(go);
	await waitFor(() => expect(c.startServiceTest).toHaveBeenCalledTimes(1));
	expect(c.startServiceTest.mock.calls[0]?.[0]).toMatchObject({
		targetId: "image",
		revision: 2,
		input: { width: 512, height: 512, format: "png" },
	});
});
test("diagnosis is explicit and separate from generation", async () => {
	const c = setup();
	await screen.findByRole("button", { name: /画像生成/ });
	fireEvent.click(screen.getByRole("button", { name: "自己診断" }));
	await waitFor(() => expect(c.diagnoseServices).toHaveBeenCalledTimes(1));
	expect(c.startServiceTest).not.toHaveBeenCalled();
});
test("stale catalog and unsaved settings block execution", async () => {
	setup(true, true);
	const go = await screen.findByRole("button", { name: "▶ 画像を生成" });
	expect((go as HTMLButtonElement).disabled).toBe(true);
	expect(
		(screen.getByRole("button", { name: "自己診断" }) as HTMLButtonElement)
			.disabled,
	).toBe(true);
	expect(screen.getByText(/設定に未適用の変更/)).toBeTruthy();
});
test("ASR explains the silent quick sample and accepts an explicit WAV file", async () => {
	const c = setup();
	fireEvent.click(
		await screen.findByRole("button", { name: /音声認識.*qwen-asr/ }),
	);
	expect(screen.getByText(/無音サンプルで通信を確認/)).toBeTruthy();
	expect(screen.getByLabelText("音声ファイル（WAV・4 MBまで）")).toBeTruthy();
	fireEvent.click(screen.getByRole("button", { name: "▶ 簡単テストを実行" }));
	await waitFor(() => expect(c.startServiceTest).toHaveBeenCalledTimes(1));
	expect(c.startServiceTest.mock.calls[0]?.[0]).toMatchObject({
		targetId: "asr",
	});
});
