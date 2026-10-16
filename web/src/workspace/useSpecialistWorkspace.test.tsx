import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, expect, test, vi } from "vitest";
import type { SpecialistSession } from "../../../api/domains/dialogue/contracts";
import type { EumenesClient } from "../../../client";
import { ApiError } from "../../../client/transport";
import { useArtifactWorkspace } from "../domains/artifact";
import { useSpecialistWorkspace } from "./useSpecialistWorkspace";

afterEach(cleanup);

const studio = "artifact:ui.studio@1";
const studioTab = "toolchain-artifact-ui-studio-1";
const session = (over: Partial<SpecialistSession> = {}): SpecialistSession => ({
	id: "sess-1",
	conversationId: "main",
	toolchainId: "ui.compose",
	toolchainRevisionId: "toolchain:ui.compose@2",
	title: "UI自由制作",
	artifactRevisionId: studio,
	adapterRef: "adapter:ui-compositions@1",
	workRef: "work-1",
	state: "active",
	endReason: null,
	revision: 4,
	epoch: 1,
	activeRunId: null,
	dirty: true,
	busy: false,
	label: "案",
	expiresAt: "2026-10-18T09:00:00.000Z",
	pendingSwitch: null,
	createdAt: "2026-10-17T09:00:00.000Z",
	updatedAt: "2026-10-17T09:00:00.000Z",
	...over,
});

function setup(initial: SpecialistSession | null) {
	let current = initial;
	const specialistCommand = vi.fn(async () => ({}));
	const client = {
		identity: crypto.randomUUID(),
		specialistSession: vi.fn(async () => ({ session: current })),
		specialistCommand,
		cancel: vi.fn(async () => ({})),
		toolchainArtifacts: vi.fn(async () => [
			{
				artifactRevisionId: "artifact:ui.definition@1",
				title: "OpenUI設定JSON",
				adapterRef: "adapter:ui-compositions@1",
			},
		]),
	} as unknown as EumenesClient & {
		specialistCommand: typeof specialistCommand;
	};
	const cache = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const hook = renderHook(
		({ signature }: { signature: string }) => {
			const artifacts = useArtifactWorkspace();
			const toolchain = {
				entries: [
					{
						artifactRevisionId: studio,
						title: "UI自由制作",
						adapterRef: "adapter:ui-compositions@1",
					},
				],
				openEntry: (
					entry: { artifactRevisionId: string; title: string },
					targetRef?: string,
				) =>
					artifacts.open({
						id: `toolchain-${entry.artifactRevisionId.replace(/[^A-Za-z0-9_-]+/g, "-")}`,
						kind: "toolchain",
						title: entry.title,
						artifactRevisionId: entry.artifactRevisionId,
						...(targetRef ? { targetRef } : {}),
					}),
			};
			const ws = useSpecialistWorkspace({
				client,
				artifacts,
				// biome-ignore lint/suspicious/noExplicitAny: the launcher stub has only what is used
				toolchain: toolchain as any,
				runSignature: signature,
			});
			return { artifacts, ws };
		},
		{
			initialProps: { signature: "" },
			wrapper: ({ children }: PropsWithChildren) => (
				<QueryClientProvider client={cache}>{children}</QueryClientProvider>
			),
		},
	);
	return {
		hook,
		client,
		cache,
		set: async (next: SpecialistSession | null, signature: string) => {
			current = next;
			hook.rerender({ signature });
			await waitFor(() =>
				expect(hook.result.current.ws.session?.id ?? null).toBe(
					next?.id ?? null,
				),
			);
		},
	};
}
const tabIds = (h: ReturnType<typeof setup>) =>
	h.hook.result.current.artifacts.tabs.map((t) => t.id);

test("a session starting after the first read opens the studio, shows the draft and announces the switch", async () => {
	const h = setup(null);
	await waitFor(() => expect(h.client.specialistSession).toHaveBeenCalled());
	expect(h.hook.result.current.ws.addressee).toMatchObject({ kind: "normal" });
	expect(h.hook.result.current.ws.notice).toBeNull();
	await h.set(session(), "run-1:running");
	await waitFor(() => expect(tabIds(h)).toEqual([studioTab]));
	expect(h.hook.result.current.ws.addressee).toEqual({
		kind: "specialist",
		label: "UI自由制作",
	});
	expect(h.hook.result.current.ws.notice).toContain(
		"サブエージェントに切り替えます",
	);
	h.cache.clear();
});

test("an open studio is not duplicated and returns to the draft when a session starts", async () => {
	const h = setup(null);
	await waitFor(() => expect(h.client.specialistSession).toHaveBeenCalled());
	act(() =>
		h.hook.result.current.artifacts.open({
			id: studioTab,
			kind: "toolchain",
			title: "UI自由制作",
			artifactRevisionId: studio,
			targetRef: "saved-1",
		}),
	);
	await h.set(session(), "run-1:running");
	await waitFor(() => {
		const tab = h.hook.result.current.artifacts.tabs[0];
		expect(tab?.kind === "toolchain" && tab.targetRef).toBeFalsy();
	});
	expect(tabIds(h)).toEqual([studioTab]);
	h.cache.clear();
});

test("a session found on load opens its studio without a switch notice", async () => {
	const h = setup(session());
	await waitFor(() => expect(tabIds(h)).toEqual([studioTab]));
	expect(h.hook.result.current.ws.notice).toBeNull();
	h.cache.clear();
});

test("a suspended session is the normal addressee, with the held work named", async () => {
	const h = setup(session({ state: "suspended" }));
	await waitFor(() =>
		expect(h.hook.result.current.ws.session?.state).toBe("suspended"),
	);
	expect(h.hook.result.current.ws.addressee).toMatchObject({
		kind: "normal",
		suspended: "UI自由制作",
	});
	expect(tabIds(h)).toEqual([]);
	h.cache.clear();
});

test("closing the studio with unsaved work asks first; discarding closes it", async () => {
	const h = setup(session());
	await waitFor(() => expect(tabIds(h)).toEqual([studioTab]));
	act(() => h.hook.result.current.ws.closeTab(studioTab));
	await waitFor(() => expect(h.hook.result.current.ws.confirm).not.toBeNull());
	expect(tabIds(h)).toEqual([studioTab]);
	// Keep editing leaves everything as it was.
	act(() => h.hook.result.current.ws.confirm?.keep());
	expect(h.hook.result.current.ws.confirm).toBeNull();
	expect(h.client.specialistCommand).not.toHaveBeenCalled();

	act(() => h.hook.result.current.ws.closeTab(studioTab));
	await waitFor(() => expect(h.hook.result.current.ws.confirm).not.toBeNull());
	await act(async () => {
		await h.hook.result.current.ws.confirm?.discard();
	});
	expect(h.client.specialistCommand).toHaveBeenCalledWith(
		"sess-1",
		"discard",
		expect.objectContaining({ expectedRevision: 4 }),
	);
	expect(tabIds(h)).toEqual([]);
	h.cache.clear();
});

test("a clean session is closed on the server before its screen goes away", async () => {
	const h = setup(session({ dirty: false }));
	await waitFor(() => expect(tabIds(h)).toEqual([studioTab]));
	act(() => h.hook.result.current.ws.closeTab(studioTab));
	await waitFor(() => expect(tabIds(h)).toEqual([]));
	expect(h.client.specialistCommand).toHaveBeenCalledWith(
		"sess-1",
		"close",
		expect.objectContaining({ expectedRevision: 4 }),
	);
	expect(h.hook.result.current.ws.confirm).toBeNull();
	h.cache.clear();
});

test("when the server says the work is unsaved after all, the user is asked instead", async () => {
	const h = setup(session({ dirty: false }));
	await waitFor(() => expect(tabIds(h)).toEqual([studioTab]));
	h.client.specialistCommand.mockRejectedValueOnce(
		new ApiError(409, "work_unsaved"),
	);
	act(() => h.hook.result.current.ws.closeTab(studioTab));
	await waitFor(() => expect(h.hook.result.current.ws.confirm).not.toBeNull());
	expect(tabIds(h)).toEqual([studioTab]);
	h.cache.clear();
});

test("other screens close without touching the session", async () => {
	const h = setup(session());
	await waitFor(() => expect(tabIds(h)).toEqual([studioTab]));
	act(() =>
		h.hook.result.current.artifacts.open({
			id: "toolchain-artifact-timer-1",
			kind: "toolchain",
			title: "タイマー",
			artifactRevisionId: "artifact:timer@1",
		}),
	);
	act(() => h.hook.result.current.ws.closeTab("toolchain-artifact-timer-1"));
	await waitFor(() => expect(tabIds(h)).toEqual([studioTab]));
	expect(h.client.specialistCommand).not.toHaveBeenCalled();
	h.cache.clear();
});

test("the viewed saved work of the focused studio is sent with a message", async () => {
	const h = setup(null);
	await waitFor(() => expect(h.client.specialistSession).toHaveBeenCalled());
	expect(h.hook.result.current.ws.viewing()).toBeUndefined();
	act(() =>
		h.hook.result.current.artifacts.open({
			id: studioTab,
			kind: "toolchain",
			title: "UI自由制作",
			artifactRevisionId: studio,
			targetRef: "saved-1",
		}),
	);
	await waitFor(() =>
		expect(h.hook.result.current.ws.viewing()).toEqual({
			artifactRevisionId: studio,
			targetRef: "saved-1",
		}),
	);
	act(() =>
		h.hook.result.current.artifacts.open({
			id: "toolchain-artifact-timer-1",
			kind: "toolchain",
			title: "タイマー",
			artifactRevisionId: "artifact:timer@1",
			targetRef: "t1",
		}),
	);
	await waitFor(() =>
		expect(h.hook.result.current.ws.viewing()).toBeUndefined(),
	);
	h.cache.clear();
});

test("the addressee the user saw is the active session, or the main agent", async () => {
	const h = setup(session({ epoch: 3 }));
	await waitFor(() => expect(h.hook.result.current.ws.session).not.toBeNull());
	expect(h.hook.result.current.ws.addresseeNow()).toEqual({
		sessionId: "sess-1",
		epoch: 3,
	});
	await h.set(session({ epoch: 4, state: "suspended" }), "run-2:completed");
	await waitFor(() =>
		expect(h.hook.result.current.ws.addresseeNow()).toEqual({
			sessionId: null,
			epoch: null,
		}),
	);
	h.cache.clear();
});

test("discarding while a turn runs says to stop first", async () => {
	const h = setup(session());
	await waitFor(() => expect(tabIds(h)).toEqual([studioTab]));
	h.client.specialistCommand.mockRejectedValueOnce(
		new ApiError(409, "work_busy"),
	);
	let result: { ok: boolean; message?: string } | undefined;
	await act(async () => {
		result = await h.hook.result.current.ws.bridge.command("discard");
	});
	expect(result).toEqual({
		ok: false,
		message: "専門担当の作業中です。停止してから操作してください。",
	});
	h.cache.clear();
});

test("closing the tab while a turn runs keeps the screen and says to stop first", async () => {
	const h = setup(session({ dirty: false, busy: true }));
	await waitFor(() => expect(tabIds(h)).toEqual([studioTab]));
	h.client.specialistCommand.mockRejectedValueOnce(
		new ApiError(409, "work_busy"),
	);
	act(() => h.hook.result.current.ws.closeTab(studioTab));
	await waitFor(() =>
		expect(h.hook.result.current.ws.notice).toBe(
			"専門担当の作業中です。停止してから操作してください。",
		),
	);
	expect(tabIds(h)).toEqual([studioTab]);
	h.cache.clear();
});
