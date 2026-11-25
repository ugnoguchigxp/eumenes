import { expect, test } from "bun:test";
import { Hono } from "hono";
import { registerTerminals } from "../controller";
import { createTerminals, type TerminalWatchPort } from "../service";
import { fakePty, openTestStore } from "./terminals.fixture";

const paneId = "33333333-3333-4333-8333-333333333333";

function watchPort(log: string[]): TerminalWatchPort & { change(): void } {
	let listener: (() => void) | undefined;
	return {
		listInTransaction: () => [
			{
				id: paneId,
				title: "背景色の実装",
				status: "running",
				activity: "working",
				startedAt: "2026-11-25T11:48:49.000Z",
			},
		],
		requestsInTransaction: () => 2,
		hasInTransaction: (_db, id) => id === paneId,
		async stream(id) {
			log.push(`stream:${id}`);
			return new Response("event: exit\ndata: {}\n\n", {
				headers: { "Content-Type": "text/event-stream" },
			});
		},
		subscribe(next) {
			listener = next;
			return () => {
				listener = undefined;
			};
		},
		change() {
			listener?.();
		},
	};
}

test("the screen lists the handed-over works read-only after the sessions; the session list stays the sessions", async () => {
	const { store, close } = openTestStore();
	const pty = fakePty();
	const terminals = createTerminals({
		store,
		command: ["claude"],
		spawn: pty.spawn,
	});
	try {
		const log: string[] = [];
		const port = watchPort(log);
		terminals.configureWatch(port);
		const session = terminals.start({ cols: 80, rows: 24 });
		const screens = terminals.screens();
		expect(screens.sessions.map((s) => [s.id, s.owner, s.readOnly])).toEqual([
			[session.id, "direct", undefined],
			[paneId, `claude-task:${paneId}`, true],
		]);
		expect(screens.requests).toBe(terminals.list().requests + 2);
		// The workspace guard and the conversation's snapshot read `list()`: the panes are not there.
		expect(terminals.list().sessions.map((s) => s.id)).toEqual([session.id]);

		// A change of the works advances the revision, so the screen reads the list again.
		const before = terminals.list().revision;
		port.change();
		expect(terminals.list().revision).toBe(before + 1);

		// A pane has no size to send; a session still gets its resize.
		terminals.resize(paneId, { cols: 100, rows: 30 });
		terminals.resize(session.id, { cols: 100, rows: 30 });
		expect(pty.spawned[0]!.sizes.at(-1)).toEqual({ cols: 100, rows: 30 });

		// Output: the pane's from the watch, the session's from its PTY.
		const app = new Hono();
		registerTerminals(app, terminals);
		const pane = await app.request(`/api/terminals/${paneId}/output`);
		expect(await pane.text()).toContain("event: exit");
		expect(log).toEqual([`stream:${paneId}`]);
		expect(
			terminals.watchStream(session.id, new AbortController().signal),
		).toBeNull();
		const listed = await (await app.request("/api/terminals")).json();
		expect(listed.sessions).toHaveLength(2);
	} finally {
		terminals.closeAll();
		await close();
	}
});
