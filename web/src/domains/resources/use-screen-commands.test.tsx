import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ScreenCommand } from "../../../../api/domains/resources/contracts";
import {
	jsonResponse,
	queryWrapper,
	recordingLauncher,
	stubApi,
	testClient,
} from "./test-support";
import {
	resetScreenCommandMemory,
	useScreenCommands,
} from "./use-screen-commands";

beforeEach(resetScreenCommandMemory);
afterEach(() => vi.unstubAllGlobals());

const command = (
	seq: number,
	over: Partial<ScreenCommand> = {},
): ScreenCommand => ({
	seq,
	conversationId: "main",
	uri: `eumenes://image/i${seq}`,
	action: "open",
	adapterRef: "adapter:x@1",
	targetRef: `t${seq}`,
	status: "pending",
	createdAt: new Date().toISOString(),
	settledAt: null,
	...over,
});

function setup(
	respond: (after: number) => ScreenCommand[],
	launcherOptions?: Parameters<typeof recordingLauncher>[0],
) {
	const receipts: Array<{ seq: number; outcome: unknown }> = [];
	const calls = stubApi({
		"/api/screen/commands?*": ({ path }) =>
			jsonResponse({
				commands: respond(
					Number(new URL(path, "http://x").searchParams.get("after")),
				),
			}),
		"/api/screen/commands/*": ({ path, body }) => {
			receipts.push({
				seq: Number(path.split("/")[4]?.split("?")[0]),
				outcome: (body as { outcome: unknown }).outcome,
			});
			return jsonResponse({ ok: true, command: command(1) });
		},
	});
	const notify = vi.fn();
	const launcher = recordingLauncher(launcherOptions);
	const { wrapper, cache } = queryWrapper();
	renderHook(
		() =>
			useScreenCommands({
				client: testClient,
				conversationId: "main",
				launcher: launcher.launcher,
				notify,
			}),
		{ wrapper },
	);
	return { receipts, calls, notify, cache, ...launcher };
}

test("commands run in seq order, one at a time, and each is acknowledged as done", async () => {
	const { receipts, events } = setup(() => [
		command(7, { action: "play" }),
		command(5),
	]);
	await waitFor(() => expect(receipts).toHaveLength(2));
	expect(events).toEqual([
		"open adapter:x@1 t5",
		"focus t5",
		"open adapter:x@1 t7",
		"focus t7",
		"play t7",
	]);
	expect(receipts).toEqual([
		{ seq: 5, outcome: "done" },
		{ seq: 7, outcome: "done" },
	]);
});

test("a seq that was seen is never run again and later polls ask only for newer commands", async () => {
	const { receipts, calls, cache, events } = setup((after) =>
		after < 2 ? [command(1), command(2)] : [command(2)],
	);
	await waitFor(() => expect(receipts).toHaveLength(2));
	// The same pending commands come back until the receipt lands: they are not handed out again.
	await cache.invalidateQueries();
	await waitFor(() =>
		expect(
			calls.some(
				(c) =>
					c.path.startsWith("/api/screen/commands?") &&
					c.path.endsWith("after=2"),
			),
		).toBe(true),
	);
	expect(receipts.map((r) => r.seq)).toEqual([1, 2]);
	expect(events.filter((e) => e.startsWith("open"))).toHaveLength(2);
});

test("a refused automatic play is acknowledged as blocked and the user is told", async () => {
	const { receipts, notify } = setup(() => [command(1, { action: "play" })], {
		play: async () => {
			throw new DOMException("blocked", "NotAllowedError");
		},
	});
	await waitFor(() =>
		expect(receipts).toEqual([{ seq: 1, outcome: "blocked" }]),
	);
	expect(notify).toHaveBeenCalledOnce();
});

test("a screen that cannot be opened, or has no such item, is acknowledged as unavailable", async () => {
	const noScreen = setup(() => [command(1)], { opens: false });
	await waitFor(() =>
		expect(noScreen.receipts).toEqual([{ seq: 1, outcome: "unavailable" }]),
	);
	resetScreenCommandMemory();
	const noItem = setup(() => [command(1)], { focus: false });
	await waitFor(() =>
		expect(noItem.receipts).toEqual([{ seq: 1, outcome: "unavailable" }]),
	);
	resetScreenCommandMemory();
	const cannotPlay = setup(() => [command(1, { action: "play" })], {
		hasPlay: false,
	});
	await waitFor(() =>
		expect(cannotPlay.receipts).toEqual([{ seq: 1, outcome: "unavailable" }]),
	);
});

test("a command nobody received within its time to live is dropped without a receipt", async () => {
	const { receipts, events, calls } = setup(() => [
		command(1, { createdAt: new Date(Date.now() - 60_000).toISOString() }),
		command(2),
	]);
	await waitFor(() => expect(receipts).toHaveLength(1));
	expect(receipts[0]?.seq).toBe(2);
	expect(events.filter((e) => e.startsWith("open"))).toEqual([
		"open adapter:x@1 t2",
	]);
	expect(calls.some((c) => c.path.includes("/commands/1/"))).toBe(false);
});
