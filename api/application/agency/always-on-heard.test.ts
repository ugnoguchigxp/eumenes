import { expect, test } from "bun:test";
import { createAgendaHearing, HEARD_GRACE_MS } from "./always-on-heard";
import type { AgendaScope } from "./always-on-scope";

function fixture() {
	let now = 1_000_000,
		attended = true,
		playing = false,
		woken = 0;
	const timers = new Map<object, { at: number; fn(): void }>();
	const c = { id: "ao", unheard: [] } as unknown as AgendaScope;
	const said: Array<[string, number]> = [];
	const failures: unknown[] = [];
	const hearing = createAgendaHearing({
		now: () => now,
		attended: () => attended,
		playing: () => playing,
		setTimer(fn, ms) {
			const id = {};
			timers.set(id, { at: now + ms, fn });
			return id;
		},
		clearTimer(id) {
			timers.delete(id as object);
		},
		wake() {
			woken++;
			hearing.check(c);
		},
		failed(_c, error) {
			failures.push(error);
		},
	});
	return {
		c,
		said,
		failures,
		hearing,
		timers,
		get woken() {
			return woken;
		},
		get now() {
			return now;
		},
		screen(value: { attended?: boolean; playing?: boolean }) {
			attended = value.attended ?? attended;
			playing = value.playing ?? playing;
			return hearing.check(c);
		},
		advance(ms: number) {
			now += ms;
			for (const [id, timer] of Array.from(timers))
				if (timer.at <= now) {
					timers.delete(id);
					timer.fn();
				}
		},
		appear(id: string, own = false) {
			hearing.appeared(c, { id, at: now, own }, (at) => said.push([id, at]));
		},
	};
}

test("with no screen on the conversation a line is said when it appears", () => {
	const f = fixture();
	f.screen({ attended: false });
	f.appear("reply-a");
	expect(f.said).toEqual([["reply-a", f.now]]);
	expect(f.c.unheard).toHaveLength(0);
	expect(f.timers.size).toBe(0);
});

test("a line a screen reads aloud is said when the reading ends", () => {
	const f = fixture();
	const appeared = f.now;
	f.appear("reply-a");
	expect(f.said).toHaveLength(0);
	// The reading begins within the grace and outlasts it.
	f.advance(1000);
	expect(f.screen({ playing: true })).toBe(false);
	f.advance(HEARD_GRACE_MS);
	expect(f.said).toHaveLength(0);
	f.advance(20_000);
	expect(f.screen({ playing: false })).toBe(true);
	expect(f.said).toEqual([
		["reply-a", appeared + 1000 + HEARD_GRACE_MS + 20_000],
	]);
	expect(f.c.unheard).toHaveLength(0);
	// A line that appears while another is read waits for the end of the reading too.
	f.screen({ playing: true });
	f.appear("reply-b");
	expect(f.timers.size).toBe(0);
	f.advance(5000);
	f.screen({ playing: false });
	expect(f.said.at(-1)).toEqual(["reply-b", f.now]);
});

test("a line nobody reads aloud is said when it appeared, once the grace is over or the screen left", () => {
	const f = fixture();
	const appeared = f.now;
	f.appear("reply-a");
	f.advance(HEARD_GRACE_MS - 1);
	expect(f.screen({})).toBe(false);
	expect(f.said).toHaveLength(0);
	f.advance(1);
	expect(f.woken).toBe(1);
	expect(f.said).toEqual([["reply-a", appeared]]);
	const second = f.now;
	f.appear("reply-b");
	expect(f.screen({ attended: false })).toBe(true);
	expect(f.said.at(-1)).toEqual(["reply-b", second]);
	expect(f.timers.size).toBe(0);
});

test("the user's words end the reading for the agent; a reply taken back is not told, a line of its own is", () => {
	const f = fixture();
	const appeared = f.now;
	f.screen({ playing: true });
	f.appear("reply-a");
	f.advance(4000);
	// Never before the line appeared, never after now.
	f.hearing.flush(f.c, appeared - 10_000);
	expect(f.said).toEqual([["reply-a", appeared]]);
	f.appear("reply-b");
	f.appear("agency:s:t1", true);
	f.hearing.drop(f.c, "reply-b");
	f.hearing.drop(f.c, "agency:s:t1");
	expect(f.c.unheard.map((u) => u.id)).toEqual(["agency:s:t1"]);
	f.hearing.flush(f.c, f.now + 60_000);
	expect(f.said.at(-1)).toEqual(["agency:s:t1", f.now]);
	// A line the agent could not take is not waited for again.
	f.hearing.appeared(f.c, { id: "reply-x", at: f.now, own: false }, () => {
		throw new Error("fixture");
	});
	expect(f.screen({ playing: false })).toBe(true);
	expect(f.failures).toHaveLength(1);
	expect(f.c.unheard).toHaveLength(0);
	f.appear("reply-c");
	f.hearing.dispose(f.c);
	expect(f.timers.size).toBe(0);
	expect(f.c.unheard).toHaveLength(0);
});
