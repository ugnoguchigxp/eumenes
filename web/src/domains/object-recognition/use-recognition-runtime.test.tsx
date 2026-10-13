import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, test, vi } from "vitest";
import type { ReactNode } from "react";
import type { EumenesClient } from "../../../../client";
import type { RecognitionRecord } from "../../../../api/domains/object-recognition/contracts";
import { useRecognitionRuntime } from "./use-recognition-runtime";
import { recognitionSource } from "./artifact-definition";
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
