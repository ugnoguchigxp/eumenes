import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, test, vi } from "vitest";
import type { Settings } from "../../../../api/domains/settings/contracts";
import { useBackground } from ".";
import { settingsFixture } from "./sections/fixture";

afterEach(cleanup);

function setup(saved: Settings = settingsFixture(), fail = false) {
	const client = {
		identity: "test",
		settings: vi.fn(async () => saved),
		applySettings: vi.fn(async (input: { settings: Settings }) => {
			if (fail) throw new Error("conflict");
			return { ...input.settings, revision: saved.revision + 1 };
		}),
	};
	const queries = new QueryClient();
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={queries}>{children}</QueryClientProvider>
	);
	const hook = renderHook(() => useBackground(client as never), { wrapper });
	return { client, hook };
}

test("an unset background reads as the light fairy", async () => {
	const saved = settingsFixture();
	delete saved.general.background;
	const { hook } = setup(saved);
	await waitFor(() => expect(hook.result.current.ready).toBe(true));
	expect(hook.result.current.selected).toBe("light-fairy");
});

test("picking a background saves only that field and shows the saved value", async () => {
	const saved = settingsFixture();
	saved.general.background = "light-fairy";
	const { client, hook } = setup(saved);
	await waitFor(() => expect(hook.result.current.ready).toBe(true));
	await act(() => hook.result.current.select("spatial"));
	const sent = client.applySettings.mock.calls[0]?.[0] as {
		expectedRevision: number;
		settings: Settings;
	};
	expect(sent.expectedRevision).toBe(saved.revision);
	expect(sent.settings).toEqual({
		...saved,
		general: { ...saved.general, background: "spatial" },
	});
	await waitFor(() => expect(hook.result.current.selected).toBe("spatial"));
});

test("picking the current background does not save", async () => {
	const saved = settingsFixture();
	saved.general.background = "spatial";
	const { client, hook } = setup(saved);
	await waitFor(() => expect(hook.result.current.ready).toBe(true));
	await act(() => hook.result.current.select("spatial"));
	expect(client.applySettings).not.toHaveBeenCalled();
});

test("a failed save reports an error and keeps the saved background", async () => {
	const saved = settingsFixture();
	saved.general.background = "light-fairy";
	const { hook } = setup(saved, true);
	await waitFor(() => expect(hook.result.current.ready).toBe(true));
	await act(() => hook.result.current.select("spatial"));
	expect(hook.result.current.error).toBe("背景を切り替えられませんでした");
	expect(hook.result.current.selected).toBe("light-fairy");
	expect(hook.result.current.busy).toBe(false);
});
