import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, test, vi } from "vitest";
import type { ReactNode } from "react";
import type { EumenesClient } from "../../../../client";
import type { RecognitionRecord } from "../../../../api/domains/object-recognition/contracts";
import { useRecognitionRuntime } from "./use-recognition-runtime";
import { recognitionSource } from "./source";
test("credential selection works before uploading any media and sends only a reference with the saved revision", async () => {
	let connection = {
		revision: 4,
		baseUrl: "http://fixture.invalid",
		credentialConfigured: true,
		credentialSource: "dedicated" as "dedicated" | "larm",
		sharedCredentialAvailable: true,
	};
	const configure = vi.fn(async (input) => {
		connection = {
			...connection,
			credentialSource: input.credentialSource,
			revision: 5,
		};
	});
	const client = {
		identity: "credential-fixture",
		recognitionRecords: vi.fn(async () => []),
		recognitionConnection: vi.fn(async () => connection),
		configureRecognitionConnection: configure,
	} as unknown as EumenesClient;
	const cache = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const hook = renderHook(() => useRecognitionRuntime(client), {
		wrapper: ({ children }: { children: ReactNode }) => (
			<QueryClientProvider client={cache}>{children}</QueryClientProvider>
		),
	});
	try {
		await waitFor(() =>
			expect(
				hook.result.current.runtime.snapshot[recognitionSource].revision,
			).toBe(4),
		);
		const event = {
			id: crypto.randomUUID(),
			source: recognitionSource,
			revision: 4,
			action: "recognition-credential-source" as const,
			values: { credentialSource: "larm" },
		};
		await act(async () => {
			expect((await hook.result.current.runtime.dispatch(event)).status).toBe(
				"accepted",
			);
		});
		expect(configure).toHaveBeenCalledExactlyOnceWith({
			expectedRevision: 4,
			credentialSource: "larm",
		});
		await waitFor(() =>
			expect(
				hook.result.current.runtime.snapshot[recognitionSource]
					.credentialSource,
			).toBe("larm"),
		);
		expect((await hook.result.current.runtime.dispatch(event)).status).toBe(
			"conflict",
		);
		expect(configure).toHaveBeenCalledOnce();
	} finally {
		hook.unmount();
		cache.clear();
	}
});
test("changing the viewed input while upload is pending prevents its late receipt from replacing the user's selection", async () => {
	const old: RecognitionRecord = {
		id: crypto.randomUUID(),
		conversationId: "main",
		name: "old.png",
		mime: "image/png",
		state: "cancelled",
		revision: 1,
		progress: null,
		errorCode: null,
		result: null,
		createdAt: 1,
		updatedAt: 1,
	};
	const fresh: RecognitionRecord = {
		...old,
		id: crypto.randomUUID(),
		name: "new.png",
		state: "queued",
	};
	let records = [old];
	let resolve!: (v: RecognitionRecord) => void;
	const upload = new Promise<RecognitionRecord>((r) => {
		resolve = r;
	});
	const client = {
		identity: "fixture",
		recognitionRecords: vi.fn(async () => records),
		recognitionConnection: vi.fn(async () => ({ credentialConfigured: true })),
		recognitionContent: vi.fn(
			async () => new Blob(["saved image"], { type: "image/png" }),
		),
		recognitionUpload: vi.fn(() => upload),
		recognitionGet: vi.fn(),
	} as unknown as EumenesClient;
	const cache = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const hook = renderHook(() => useRecognitionRuntime(client), {
		wrapper: ({ children }: { children: ReactNode }) => (
			<QueryClientProvider client={cache}>{children}</QueryClientProvider>
		),
	});
	try {
		await waitFor(() =>
			expect(
				hook.result.current.runtime.snapshot[recognitionSource].selectedId,
			).toBe(old.id),
		);
		await waitFor(() =>
			expect(client.recognitionContent).toHaveBeenCalledWith(
				old.id,
				expect.anything(),
			),
		);
		let pending!: ReturnType<typeof hook.result.current.runtime.uploadFile>;
		act(() => {
			pending = hook.result.current.runtime.uploadFile(
				recognitionSource,
				new File(["png"], "new.png", { type: "image/png" }),
			);
		});
		await act(async () => {
			await hook.result.current.runtime.dispatch({
				id: crypto.randomUUID(),
				source: recognitionSource,
				revision:
					hook.result.current.runtime.snapshot[recognitionSource].revision,
				action: "recognition-select",
				values: { id: old.id },
			});
		});
		records = [fresh, old];
		await act(async () => {
			resolve(fresh);
			await pending;
		});
		expect(
			hook.result.current.runtime.snapshot[recognitionSource].selectedId,
		).toBe(old.id);
		expect(client.recognitionUpload).toHaveBeenCalledOnce();
	} finally {
		hook.unmount();
		cache.clear();
	}
});
test("a capture request is shown, answered by the taken still and sent once after its detection ends", async () => {
	const handoff = {
		id: "handoff-1",
		conversationId: "main",
		source: "camera" as const,
		recognitionId: null,
		question: "今日の服どう？",
		state: "pending" as const,
		deadline: Date.now() + 60_000,
	};
	const still: RecognitionRecord = {
		id: crypto.randomUUID(),
		conversationId: "main",
		name: "camera.jpg",
		mime: "image/jpeg",
		state: "running",
		revision: 1,
		progress: null,
		errorCode: null,
		result: null,
		createdAt: 1,
		updatedAt: 1,
		origin: "camera",
	};
	let records: RecognitionRecord[] = [];
	let handoffs = [handoff];
	const send = vi.fn(async () => {
		handoffs = [];
		return {};
	});
	const client = {
		identity: "handoff-fixture",
		recognitionRecords: vi.fn(async () => records),
		recognitionConnection: vi.fn(async () => ({ credentialConfigured: true })),
		recognitionContent: vi.fn(
			async () => new Blob(["jpg"], { type: "image/jpeg" }),
		),
		recognitionHandoffs: vi.fn(async () => handoffs),
		recognitionUpload: vi.fn(async () => {
			records = [still];
			return still;
		}),
		recognitionHandoffSend: send,
	} as unknown as EumenesClient;
	const cache = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const hook = renderHook(() => useRecognitionRuntime(client), {
		wrapper: ({ children }: { children: ReactNode }) => (
			<QueryClientProvider client={cache}>{children}</QueryClientProvider>
		),
	});
	try {
		await waitFor(() =>
			expect(
				hook.result.current.runtime.snapshot[recognitionSource].handoff,
			).toEqual({
				id: "handoff-1",
				source: "camera",
				question: "今日の服どう？",
			}),
		);
		await act(async () => {
			await hook.result.current.runtime.uploadFile(
				recognitionSource,
				new File(["jpg"], "camera.jpg", { type: "image/jpeg" }),
				{ origin: "camera", handoffId: "handoff-1" },
			);
		});
		expect(client.recognitionUpload).toHaveBeenCalledWith(
			expect.any(File),
			"main",
			expect.any(String),
			"camera",
			"handoff-1",
		);
		expect(
			hook.result.current.runtime.snapshot[recognitionSource].handoff,
		).toBeUndefined();
		expect(send).not.toHaveBeenCalled();
		records = [{ ...still, state: "completed", revision: 2 }];
		await act(async () => {
			await cache.refetchQueries();
		});
		await waitFor(() =>
			expect(send).toHaveBeenCalledExactlyOnceWith("handoff-1", still.id),
		);
		await act(async () => {
			await cache.refetchQueries();
		});
		expect(send).toHaveBeenCalledOnce();
	} finally {
		hook.unmount();
		cache.clear();
	}
});
test("会話に追加 puts the saved attachment with its detections into the chat input queue", async () => {
	const { useRecognitionChatInbox } = await import("./chat-inbox");
	const record: RecognitionRecord = {
		id: crypto.randomUUID(),
		conversationId: "main",
		name: "desk.png",
		mime: "image/png",
		state: "completed",
		revision: 1,
		progress: null,
		errorCode: null,
		result: { kind: "image", model: "m", width: 1, height: 1, objects: [] },
		createdAt: 1,
		updatedAt: 1,
	};
	const attachment = {
		id: crypto.randomUUID(),
		conversationId: "main",
		name: "desk.png",
		mime: "image/png",
		originalMime: "image/png",
		width: 1,
		height: 1,
		size: 1,
		digest: "d",
		createdAt: "2026-10-18T00:00:00.000Z",
		annotation: { source: "object-recognition", data: { objects: [] } },
	};
	const client = {
		identity: "attach-fixture",
		recognitionRecords: vi.fn(async () => [record]),
		recognitionConnection: vi.fn(async () => ({ credentialConfigured: true })),
		recognitionContent: vi.fn(async () => new Blob(["png"])),
		recognitionHandoffs: vi.fn(async () => []),
		recognitionAttach: vi.fn(async () => attachment),
		attachmentPreview: vi.fn(
			async () => new Blob(["png"], { type: "image/png" }),
		),
	} as unknown as EumenesClient;
	const cache = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const setTargetRef = vi.fn();
	const hook = renderHook(
		() => useRecognitionRuntime(client, "main", setTargetRef),
		{
			wrapper: ({ children }: { children: ReactNode }) => (
				<QueryClientProvider client={cache}>{children}</QueryClientProvider>
			),
		},
	);
	try {
		await waitFor(() => expect(setTargetRef).toHaveBeenCalledWith(record.id));
		const event = {
			id: crypto.randomUUID(),
			source: recognitionSource,
			revision:
				hook.result.current.runtime.snapshot[recognitionSource].revision,
			action: "recognition-incorporate" as const,
			values: { id: record.id },
		};
		await act(async () => {
			expect((await hook.result.current.runtime.dispatch(event)).status).toBe(
				"accepted",
			);
		});
		expect(client.recognitionAttach).toHaveBeenCalledWith(record.id, event.id);
		const queued = useRecognitionChatInbox.getState().take();
		expect(queued.map((q) => q.attachment)).toEqual([attachment]);
		expect(queued[0]!.file.type).toBe("image/png");
	} finally {
		hook.unmount();
		cache.clear();
	}
});
