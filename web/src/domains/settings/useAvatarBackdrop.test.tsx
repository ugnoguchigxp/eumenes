import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, test, vi } from "vitest";
import type { Settings } from "../../../../api/domains/settings/contracts";
import { useAvatarBackdrop } from ".";
import { settingsFixture } from "./sections/fixture";

afterEach(cleanup);

function setup(saved: Settings, fail = false) {
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
	const hook = renderHook(() => useAvatarBackdrop(client as never), {
		wrapper,
	});
	return { client, hook };
}

test("choosing and removing the image saves only that field, each on the latest revision", async () => {
	const saved = settingsFixture();
	const { client, hook } = setup(saved);
	await waitFor(() => expect(hook.result.current.ready).toBe(true));
	expect(hook.result.current.imageId).toBeNull();
	await act(() => hook.result.current.select(null));
	expect(client.applySettings).not.toHaveBeenCalled();

	await act(() => hook.result.current.select("image_1"));
	const first = client.applySettings.mock.calls[0]?.[0] as {
		expectedRevision: number;
		settings: Settings;
	};
	expect(first.expectedRevision).toBe(saved.revision);
	expect(first.settings).toEqual({
		...saved,
		general: { ...saved.general, avatarBackdropImageId: "image_1" },
	});
	await waitFor(() => expect(hook.result.current.imageId).toBe("image_1"));

	await act(() => hook.result.current.select(null));
	const second = client.applySettings.mock.calls[1]?.[0] as {
		expectedRevision: number;
		settings: Settings;
	};
	expect(second.expectedRevision).toBe(saved.revision + 1);
	expect(second.settings.general.avatarBackdropImageId).toBeNull();
	await waitFor(() => expect(hook.result.current.imageId).toBeNull());
});

test("a failed save reports an error and keeps the saved image", async () => {
	const saved = settingsFixture();
	saved.general.avatarBackdropImageId = "image_1";
	const { hook } = setup(saved, true);
	await waitFor(() => expect(hook.result.current.ready).toBe(true));
	await act(() => hook.result.current.select("image_2"));
	expect(hook.result.current.error).toBe("背景の画像を保存できませんでした");
	expect(hook.result.current.imageId).toBe("image_1");
	expect(hook.result.current.busy).toBe(false);
});
