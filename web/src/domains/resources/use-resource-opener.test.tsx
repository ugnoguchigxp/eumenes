import { renderHook } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import {
	formatResourceUri,
	type ResolvedResource,
} from "../../../../api/domains/resources/contracts";
import {
	BLOCKED_NOTICE,
	NOT_FOUND_NOTICE,
	useResourceOpener,
} from "./use-resource-opener";
import {
	jsonResponse,
	recordingLauncher,
	stubApi,
	testClient,
} from "./test-support";

afterEach(() => vi.unstubAllGlobals());

const resource = (
	kind: string,
	id: string,
	over: Partial<ResolvedResource> = {},
): ResolvedResource => ({
	uri: formatResourceUri(kind, id),
	kind,
	label: "試験",
	createdAt: "2026-10-25T00:00:00.000Z",
	adapterRef: "adapter:x@1",
	targetRef: id,
	actions: ["open", "read"],
	kindLabel: "試験",
	defaultAction: "open",
	actionLabels: {},
	...over,
});

function setup(
	resolved: ResolvedResource | { ok: false; code: string },
	launcherOptions?: Parameters<typeof recordingLauncher>[0],
) {
	const calls = stubApi({
		"/api/resources/resolve?*": () =>
			jsonResponse(
				"kind" in resolved ? { ok: true, resource: resolved } : resolved,
			),
	});
	const notify = vi.fn();
	const { launcher, events } = recordingLauncher(launcherOptions);
	const { result } = renderHook(() =>
		useResourceOpener({ client: testClient, launcher, notify }),
	);
	return { open: result.current, notify, events, calls };
}

test("resolves the URI, opens the screen at the item and points at it", async () => {
	const { open, events, calls, notify } = setup(resource("image", "image_1"));
	await expect(open("eumenes://image/image_1")).resolves.toBe("done");
	expect(calls[0]?.path).toBe(
		`/api/resources/resolve?uri=${encodeURIComponent("eumenes://image/image_1")}`,
	);
	expect(events).toEqual(["open adapter:x@1 image_1", "focus image_1"]);
	expect(notify).not.toHaveBeenCalled();
});

test("play starts the item after pointing at it; the kind's default action applies without one", async () => {
	const track = resource("music.track", "m1", {
		actions: ["play", "open", "read"],
		defaultAction: "play",
	});
	const explicit = setup(track);
	await explicit.open("eumenes://music.track/m1", "play");
	expect(explicit.events.at(-1)).toBe("play m1");
	const byDefault = setup(track);
	await byDefault.open("eumenes://music.track/m1");
	expect(byDefault.events.at(-1)).toBe("play m1");
	const link = setup(track);
	await link.open("eumenes://music.track/m1?action=open");
	expect(link.events.at(-1)).toBe("focus m1");
});

test("a resource that cannot be resolved shows the not-found notice and opens nothing", async () => {
	const missing = setup({ ok: false, code: "item_not_found" });
	await expect(missing.open("eumenes://image/gone")).resolves.toBe("not_found");
	expect(missing.notify).toHaveBeenCalledWith(NOT_FOUND_NOTICE);
	expect(missing.events).toEqual([]);

	const malformed = setup(resource("image", "x"));
	await expect(malformed.open("https://example.com")).resolves.toBe(
		"not_found",
	);
	expect(malformed.notify).toHaveBeenCalledWith(NOT_FOUND_NOTICE);
	expect(malformed.calls).toEqual([]);
});

test("a 404 from the endpoint is the same as an unresolved resource", async () => {
	stubApi({
		"/api/resources/resolve?*": () =>
			jsonResponse({ error: "item_not_found", code: "item_not_found" }, 404),
	});
	const notify = vi.fn();
	const { launcher } = recordingLauncher();
	const { result } = renderHook(() =>
		useResourceOpener({ client: testClient, launcher, notify }),
	);
	await expect(result.current("eumenes://image/gone")).resolves.toBe(
		"not_found",
	);
	expect(notify).toHaveBeenCalledWith(NOT_FOUND_NOTICE);
});

test("play on a kind that does not play is refused before any screen is touched", async () => {
	const { open, events, notify } = setup(resource("image", "image_1"));
	await expect(open("eumenes://image/image_1", "play")).resolves.toBe(
		"not_allowed",
	);
	expect(events).toEqual([]);
	expect(notify).toHaveBeenCalledOnce();
});

test("a refused automatic play tells the user to press the button", async () => {
	const { open, notify } = setup(
		resource("music.track", "m1", { actions: ["play", "open"] }),
		{
			play: async () => {
				throw new DOMException("blocked", "NotAllowedError");
			},
		},
	);
	await expect(open("eumenes://music.track/m1", "play")).resolves.toBe(
		"blocked",
	);
	expect(notify).toHaveBeenCalledWith(BLOCKED_NOTICE);
});
