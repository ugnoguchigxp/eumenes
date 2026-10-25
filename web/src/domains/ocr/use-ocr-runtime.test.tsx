import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, test, vi } from "vitest";
import type { EumenesClient } from "../../../../client";
import { ApiError } from "../../../../client/transport";
import { ocrSource } from "./source";
import { useOcrRuntime } from "./use-ocr-runtime";

afterEach(cleanup);

const line = (text: string) => ({
	text,
	confidence: 0.9,
	polygon: [
		[0, 0],
		[10, 0],
		[10, 10],
		[0, 10],
	],
});
const record = (id: string, extra: Record<string, unknown> = {}) => ({
	id,
	name: `${id}.png`,
	mime: "image/png",
	state: "completed",
	revision: 1,
	result: {
		kind: "image",
		model: "m",
		width: 100,
		height: 100,
		text: "あ\nい",
		lines: [line("あ"), line("い")],
	},
	...extra,
});
const connection = {
	revision: 2,
	serviceId: "ocr-host",
	baseUrl: "http://127.0.0.1:9000",
	credentialConfigured: true,
	sharedCredentialAvailable: true,
};

function setup(options: { records?: unknown[]; failRecords?: boolean } = {}) {
	const records = options.records ?? [record("a"), record("b")];
	const client = {
		identity: crypto.randomUUID(),
		ocrRecords: vi.fn(async () => {
			if (options.failRecords) throw new Error("offline");
			return records;
		}),
		ocrConnection: vi.fn(async () => connection),
		ocrCorrections: vi.fn(async () => ({
			items: [],
			nextCursor: null,
			preference: { preferredId: null, revision: 0 },
		})),
		ocrQr: vi.fn(async () => null),
		ocrQrCreate: vi.fn(async () => ({
			id: "qr",
			state: "completed",
			items: [],
		})),
		ocrContent: vi.fn(async () => new Blob(["x"], { type: "image/png" })),
		configureOcrConnection: vi.fn(async () => connection),
		ocrIncorporate: vi.fn(async () => ({})),
		ocrCancel: vi.fn(async () => ({})),
		ocrRecheck: vi.fn(async () => ({})),
		ocrRemove: vi.fn(async () => {}),
		ocrUpload: vi.fn(async (_file: File, _conversation: string, id: string) => {
			const saved = record(id, { state: "queued", result: undefined });
			records.push(saved);
			return saved;
		}),
		ocrGet: vi.fn(async (id: string) => record(id)),
	};
	const cache = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const hook = renderHook(
		() => useOcrRuntime(client as never as EumenesClient),
		{
			wrapper: ({ children }: { children: ReactNode }) => (
				<QueryClientProvider client={cache}>{children}</QueryClientProvider>
			),
		},
	);
	return { hook, client, cache };
}
const resource = (h: ReturnType<typeof setup>) =>
	h.hook.result.current.runtime.snapshot[ocrSource] as {
		revision: number;
		selectedId?: string;
		selectedLines: number[];
		selectionRegion?: [number, number, number, number];
		frameIndex: number;
		configured: boolean;
		baseUrl: string | null;
		error?: string;
		busy: boolean;
	};
async function loaded(h: ReturnType<typeof setup>) {
	await waitFor(() => expect(h.hook.result.current.loading).toBe(false));
}
const event = (
	h: ReturnType<typeof setup>,
	action: string,
	values: Record<string, unknown> = {},
	revision = resource(h).revision,
) =>
	({
		id: crypto.randomUUID(),
		source: ocrSource,
		revision,
		action,
		values,
	}) as never;
const send = (h: ReturnType<typeof setup>, ev: never) =>
	act(() => h.hook.result.current.runtime.dispatch(ev));

test("the snapshot selects the first record and reports the connection", async () => {
	const h = setup();
	await loaded(h);
	expect(resource(h)).toMatchObject({
		selectedId: "a",
		configured: true,
		sharedCredentialAvailable: true,
		baseUrl: "http://127.0.0.1:9000",
		busy: false,
	});
	h.cache.clear();
});

test("an event for another source or a stale revision is refused", async () => {
	const h = setup();
	await loaded(h);
	const foreign = {
		...(event(h, "ocr-refresh") as object),
		source: "x",
	} as never;
	expect(await send(h, foreign)).toMatchObject({ status: "rejected" });
	const stale = event(h, "ocr-refresh", {}, resource(h).revision + 100);
	expect(await send(h, stale)).toMatchObject({ status: "conflict" });
	h.cache.clear();
});

test("selecting a record and toggling lines is validated against the loaded result", async () => {
	const h = setup();
	await loaded(h);
	expect(await send(h, event(h, "ocr-select", { id: "zzz" }))).toMatchObject({
		status: "rejected",
	});
	expect(await send(h, event(h, "ocr-select", { id: "b" }))).toMatchObject({
		status: "accepted",
	});
	await waitFor(() => expect(resource(h).selectedId).toBe("b"));
	expect(
		await send(h, event(h, "ocr-line", { id: "b", index: 1 })),
	).toMatchObject({ status: "accepted" });
	expect(resource(h).selectedLines).toEqual([1]);
	expect(
		await send(h, event(h, "ocr-line", { id: "b", index: 5 })),
	).toMatchObject({ status: "rejected" });
	expect(
		await send(h, event(h, "ocr-line", { id: "a", index: 0 })),
	).toMatchObject({ status: "rejected" });
	expect(
		await send(h, event(h, "ocr-line", { id: "b", index: 1 })),
	).toMatchObject({ status: "accepted" });
	expect(resource(h).selectedLines).toEqual([]);
	// An image has no frames.
	expect(
		await send(h, event(h, "ocr-frame", { id: "b", index: 0 })),
	).toMatchObject({ status: "rejected" });
	h.cache.clear();
});

test("configuring the connection saves the URL with the loaded revision", async () => {
	const h = setup();
	await loaded(h);
	expect(
		await send(h, event(h, "ocr-configure", { baseUrl: 5 })),
	).toMatchObject({ status: "rejected" });
	expect(h.client.configureOcrConnection).not.toHaveBeenCalled();
	expect(
		await send(
			h,
			event(h, "ocr-configure", { baseUrl: "http://127.0.0.1:9100" }),
		),
	).toMatchObject({ status: "accepted" });
	expect(h.client.configureOcrConnection).toHaveBeenCalledWith({
		expectedRevision: 2,
		baseUrl: "http://127.0.0.1:9100",
	});
	h.cache.clear();
});

test("cancel, recheck and remove act on a known record only and refresh the list", async () => {
	const h = setup();
	await loaded(h);
	expect(await send(h, event(h, "ocr-cancel", { id: "nope" }))).toMatchObject({
		status: "rejected",
	});
	expect(h.client.ocrCancel).not.toHaveBeenCalled();
	await send(h, event(h, "ocr-cancel", { id: "a" }));
	await send(h, event(h, "ocr-recheck", { id: "a" }));
	await send(h, event(h, "ocr-remove", { id: "a" }));
	expect(h.client.ocrCancel).toHaveBeenCalledWith("a");
	expect(h.client.ocrRecheck).toHaveBeenCalledWith("a");
	expect(h.client.ocrRemove).toHaveBeenCalledWith("a");
	expect(await send(h, event(h, "ocr-unknown", { id: "a" }))).toMatchObject({
		status: "rejected",
	});
	h.cache.clear();
});

test("adding the text to the conversation checks the target, the frame and the line list", async () => {
	const h = setup();
	await loaded(h);
	expect(
		await send(h, event(h, "ocr-incorporate", { id: "b", frameIndex: "" })),
	).toMatchObject({
		status: "rejected",
		message: "対象を選び直してください。",
	});
	expect(
		await send(h, event(h, "ocr-incorporate", { id: "a", frameIndex: "70" })),
	).toMatchObject({
		status: "rejected",
		message: "時刻を選び直してください。",
	});
	expect(h.client.ocrIncorporate).not.toHaveBeenCalled();
	const ev = event(h, "ocr-incorporate", {
		id: "a",
		frameIndex: "",
		lineIndexes: "0,1",
	});
	expect(await send(h, ev)).toMatchObject({ status: "accepted" });
	expect(h.client.ocrIncorporate).toHaveBeenCalledWith(
		"a",
		(ev as { id: string }).id,
		undefined,
		[0, 1],
	);
	h.cache.clear();
});

test("a text that is too long to add is explained instead of thrown", async () => {
	const h = setup();
	await loaded(h);
	h.client.ocrIncorporate.mockRejectedValue(
		new ApiError(400, "ocr_text_too_large"),
	);
	expect(
		await send(h, event(h, "ocr-incorporate", { id: "a", frameIndex: "" })),
	).toMatchObject({
		status: "rejected",
		message: "会話に追加できる長さを超えました。行を選んで追加してください。",
	});
	h.client.ocrIncorporate.mockRejectedValue(new ApiError(500, "boom"));
	await expect(
		send(h, event(h, "ocr-incorporate", { id: "a", frameIndex: "" })),
	).rejects.toMatchObject({ status: 500 });
	h.cache.clear();
});

test("an upload with an unsupported type or size never reaches the API", async () => {
	const h = setup();
	await loaded(h);
	const text = new File(["x"], "a.txt", { type: "text/plain" });
	const rejected = await act(() =>
		h.hook.result.current.runtime.uploadFile(ocrSource, text),
	);
	expect(rejected).toMatchObject({ status: "rejected" });
	const empty = new File([], "a.png", { type: "image/png" });
	expect(
		await act(() => h.hook.result.current.runtime.uploadFile(ocrSource, empty)),
	).toMatchObject({ status: "rejected" });
	expect(
		await act(() => h.hook.result.current.runtime.uploadFile("other", text)),
	).toMatchObject({ status: "rejected" });
	expect(h.client.ocrUpload).not.toHaveBeenCalled();
	await waitFor(() =>
		expect(resource(h).error).toContain("16 MiB以内のファイル"),
	);
	h.cache.clear();
});

test("a valid upload is accepted and selected; a lost receipt is recovered from the saved record", async () => {
	const h = setup();
	await loaded(h);
	const png = new File(["x"], "a.png", { type: "image/png" });
	expect(
		await act(() => h.hook.result.current.runtime.uploadFile(ocrSource, png)),
	).toMatchObject({ status: "accepted", message: "解析を受け付けました。" });
	const sent = h.client.ocrUpload.mock.calls[0]!;
	await waitFor(() => expect(resource(h).selectedId).toBe(sent[2]));

	h.client.ocrUpload.mockRejectedValueOnce(new Error("network"));
	expect(
		await act(() => h.hook.result.current.runtime.uploadFile(ocrSource, png)),
	).toMatchObject({
		status: "accepted",
		message: "保存済みの受付に復帰しました。",
	});

	h.client.ocrUpload.mockRejectedValueOnce(new Error("network"));
	h.client.ocrGet.mockRejectedValueOnce(new Error("missing"));
	expect(
		await act(() => h.hook.result.current.runtime.uploadFile(ocrSource, png)),
	).toMatchObject({ status: "rejected", message: "受付未確認" });
	await waitFor(() =>
		expect(resource(h).error).toContain("自動再送はしていません"),
	);
	expect(resource(h).busy).toBe(false);
	h.cache.clear();
});

test("a failed list read shows a connection error", async () => {
	const h = setup({ failRecords: true });
	await waitFor(() => expect(h.hook.result.current.loading).toBe(false));
	expect(resource(h).error).toBe(
		"情報を取得できません。接続を確認してください。",
	);
	h.cache.clear();
});

test("region selection filters saved lines, rejects crossing lines and clears on frame/source change without re-reading", async () => {
	const h = setup({
		records: [
			record("a", {
				result: {
					kind: "image",
					model: "fixture",
					width: 100,
					height: 100,
					text: "内\n交差",
					lines: [
						line("内"),
						{
							...line("交差"),
							polygon: [
								[5, 5],
								[25, 5],
								[25, 15],
								[5, 15],
							],
						},
					],
				},
			}),
			record("b"),
		],
	});
	await loaded(h);
	await send(
		h,
		event(h, "ocr-region", {
			id: "a",
			scope: "a:1:0",
			region: JSON.stringify([0, 0, 15, 15]),
		}),
	);
	expect(resource(h).selectedLines).toEqual([0]);
	expect(resource(h).selectionRegion).toEqual([0, 0, 15, 15]);
	expect(
		(await send(h, event(h, "ocr-line", { id: "a", index: "1" }))).status,
	).toBe("rejected");
	expect(
		(
			await send(
				h,
				event(h, "ocr-region", {
					id: "a",
					scope: "a:1:0",
					region: JSON.stringify([0, 0, 200, 200]),
				}),
			)
		).status,
	).toBe("rejected");
	expect(h.client.ocrUpload).not.toHaveBeenCalled();
	expect(h.client.ocrRecheck).not.toHaveBeenCalled();
	await send(h, event(h, "ocr-select", { id: "b" }));
	expect(resource(h).selectionRegion).toBeUndefined();
	expect(resource(h).selectedLines).toEqual([]);
	h.cache.clear();
});
