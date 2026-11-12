import { expect, test } from "bun:test";
import { SET_QUIET, START_PREPARATION } from "eumenes-agency/agenda";
import {
	agendaFixture,
	composeSay,
	planNothing,
	replyWith,
	type CallKind,
} from "./always-on.fixture";
import { waitFor } from "../../infrastructure/wait-for";

type Fixture = Awaited<ReturnType<typeof agendaFixture>>;

const agencyMessages = (f: Fixture) =>
	f.h.conversation
		.get("ao")
		.messages.filter(
			(m) => m.role === "assistant" && m.id.startsWith("agency:"),
		);

const planTalks = (ref: string, texts: string[]) => ({
	add: texts.map((text, i) => ({
		kind: "talk",
		text,
		refs: [ref],
		value: 5 - i,
		reason: "fixture",
		topic: "thought",
	})),
	drop: [],
	focus: "thought",
});

/** A screen of the conversation, as the web reports it (each report renews its 45 s lease). */
function screen(f: Fixture) {
	const screenId = crypto.randomUUID();
	let revision = 0;
	return (flags: { typing?: boolean; playing?: boolean }) =>
		f.host.attend("ao", {
			screenId,
			revision: ++revision,
			sentAt: f.now,
			typing: flags.typing ?? false,
			playing: flags.playing ?? false,
			visible: true,
		});
}

/** Time passes second by second, the screen renewing its lease as the web does. */
async function pass(
	f: Fixture,
	report: ReturnType<typeof screen>,
	flags: { playing?: boolean },
	seconds: number,
) {
	for (let i = 0; i < seconds; i++) {
		await f.advance(1000);
		if (i % 15 === 14) await report(flags);
	}
}

test("the agent's words are said when a screen has read them to the end: its gaps run from there", async () => {
	let planned = false;
	let line = 0;
	const f = await agendaFixture({
		script: (kind: CallKind, request) => {
			if (kind === "plan" && !planned && request.prompt.includes("reply-a")) {
				planned = true;
				return planTalks("user-a", ["fixture first", "fixture second"]);
			}
			if (kind === "compose") return composeSay(`fixture line ${++line}`);
			return kind === "plan" ? planNothing() : undefined;
		},
	});
	try {
		await f.start();
		const report = screen(f);
		await report({});
		// The user is answered (a foreground run), and the screen begins to read the reply aloud.
		f.setBusy(true);
		await f.user("user-a");
		await f.assistant("reply-a", "fixture reply-a");
		await report({ playing: true });
		f.setBusy(false);
		await pass(f, report, { playing: true }, 30);
		// While it is read, the agent has not heard of the reply: nothing is planned from it.
		expect(f.calls("plan").some((r) => r.prompt.includes("reply-a"))).toBe(
			false,
		);
		expect(f.host.status("ao").idle?.blockedBy).toBe("busy");
		// The reading ends: the reply is said now, and the user has the time to respond from here.
		await report({ playing: false });
		await f.advance(1000);
		await waitFor(() => planned);
		await pass(f, report, {}, 11);
		expect(agencyMessages(f)).toHaveLength(0);
		for (let i = 0; i < 6 && agencyMessages(f).length === 0; i++)
			await f.advance(1000);
		expect(agencyMessages(f).map((m) => m.text)).toEqual(["fixture line 1"]);
		// Its own line is read aloud for a while: the next one waits for the end of that, then the gap.
		await report({ playing: true });
		await pass(f, report, { playing: true }, 40);
		expect(agencyMessages(f)).toHaveLength(1);
		await report({ playing: false });
		await pass(f, report, {}, 12);
		expect(agencyMessages(f)).toHaveLength(1);
		await pass(f, report, {}, 8);
		expect(agencyMessages(f).map((m) => m.text)).toEqual([
			"fixture line 1",
			"fixture line 2",
		]);
	} finally {
		await f.close();
	}
}, 30_000);

test("a line nobody reads aloud is said when it appeared; the user's words end a reading", async () => {
	let planned = false;
	const f = await agendaFixture({
		script: (kind: CallKind, request) => {
			if (kind === "plan" && !planned && request.prompt.includes("reply-a")) {
				planned = true;
				return planTalks("user-a", ["fixture first"]);
			}
			if (kind === "compose") return composeSay("fixture line");
			return kind === "plan" ? planNothing() : undefined;
		},
	});
	try {
		await f.start();
		const report = screen(f);
		await report({});
		f.setBusy(true);
		await f.user("user-a");
		await f.assistant("reply-a", "fixture reply-a");
		f.setBusy(false);
		// No reading begins (no auto speech): after the short grace the reply counts from when it appeared.
		await pass(f, report, {}, 5);
		await waitFor(() => planned);
		for (let i = 0; i < 15 && agencyMessages(f).length === 0; i++)
			await f.advance(1000);
		expect(agencyMessages(f).map((m) => m.text)).toEqual(["fixture line"]);
		// The line is being read when the user speaks: it is said for the agent, and their words follow it.
		await report({ playing: true });
		f.setBusy(true);
		await f.user("user-b", "ao", "fixture words after the line");
		await f.assistant("reply-b", "fixture reply-b");
		await report({ playing: false });
		f.setBusy(false);
		await f.advance(1000);
		await waitFor(() =>
			f.calls("plan").some((r) => r.prompt.includes("reply-b")),
		);
		const prompt = f
			.calls("plan")
			.findLast((r) => r.prompt.includes("reply-b"))!.prompt;
		expect(prompt.indexOf("fixture line")).toBeGreaterThan(-1);
		expect(prompt.indexOf("fixture words after the line")).toBeGreaterThan(
			prompt.indexOf("fixture line"),
		);
	} finally {
		await f.close();
	}
}, 30_000);

test("a scope joins the conversation under way: after a restart the agent plans from its latest words and keeps the quiet", async () => {
	const f = await agendaFixture();
	try {
		await f.start();
		await f.user("user-a", "ao", "fixture words before the restart");
		await replyWith(
			f,
			[
				{
					name: SET_QUIET,
					arguments: { scope: "speech", kind: "said", minutes: 30 },
				},
			],
			{ runId: "run-q", messageIds: ["user-a"] },
		);
		await f.assistant("reply-a", "fixture reply before the restart");
		await f.advance(1000);
		const quiet = () =>
			f.host.inspect("ao")!.snapshot.agent.quiet.speechUntil as number | null;
		const until = quiet();
		expect(until).toBe(f.now - 1000 + 30 * 60_000);
		const plans = f.calls("plan").length;
		await f.restart();
		await f.host.attend("ao");
		await f.advance(1000);
		await waitFor(() => f.calls("plan").length > plans);
		const prompt = f.calls("plan").at(-1)!.prompt;
		expect(prompt).toContain("fixture words before the restart");
		expect(prompt).toContain("fixture reply before the restart");
		// The user's old words did not end the quiet they asked for after them.
		expect(quiet()).toBeCloseTo(until!, -1);
	} finally {
		await f.close();
	}
}, 30_000);

test("a line caught by the user's typing in the instant it was stored is held, and said as written when they stop", async () => {
	let planned = false;
	const f = await agendaFixture({
		script: (kind: CallKind) => {
			if (kind === "plan" && !planned) {
				planned = true;
				return planTalks("user-a", ["fixture first"]);
			}
			if (kind === "compose") return composeSay("fixture held line");
			return kind === "plan" ? planNothing() : undefined;
		},
	});
	try {
		await f.start();
		// The step's thoughts are published between the agent's line and its storing: the user gets busy there.
		const publish = f.deps.publish;
		let caught = false;
		f.deps.publish = () => {
			publish();
			if (planned && !caught) {
				caught = true;
				f.setBusy(true);
			}
		};
		await f.user("user-a");
		await f.advance(1000);
		await waitFor(() => caught && f.calls("compose").length === 1);
		await f.advance(20_000);
		expect(agencyMessages(f)).toHaveLength(0);
		f.setBusy(false);
		await waitFor(() => agencyMessages(f).length === 1);
		expect(agencyMessages(f)[0]!.text).toBe("fixture held line");
		// The same line, not one written again.
		expect(f.calls("compose")).toHaveLength(1);
	} finally {
		await f.close();
	}
}, 30_000);

test("a held line is not said when the user spoke meanwhile, and the step does not wait for the user to be free", async () => {
	let planned = false;
	let line = 0;
	const f = await agendaFixture({
		script: (kind: CallKind) => {
			if (kind === "plan" && !planned) {
				planned = true;
				return planTalks("user-a", ["fixture first"]);
			}
			if (kind === "compose") return composeSay(`fixture held line ${++line}`);
			return kind === "plan" ? planNothing() : undefined;
		},
	});
	try {
		await f.start();
		const publish = f.deps.publish;
		let caught = false;
		f.deps.publish = () => {
			publish();
			if (planned && !caught) {
				caught = true;
				f.setBusy(true);
			}
		};
		await f.user("user-a");
		await f.advance(1000);
		await waitFor(() => caught && f.calls("compose").length === 1);
		// The user speaks and is answered, still busy: the held line is dropped there, so the research their
		// reply asked for is looked at without waiting for a pause.
		await f.user("user-b");
		await replyWith(
			f,
			[
				{
					name: START_PREPARATION,
					arguments: { request: "fixture asked research", askedByUser: true },
				},
			],
			{ runId: "run-b", messageIds: ["user-b"] },
		);
		const started = () =>
			f.host.thoughts("ao").some((t) => t.kind === "research");
		for (let i = 0; i < 10 && !started(); i++) await f.advance(1000);
		expect(started()).toBe(true);
		expect(agencyMessages(f)).toHaveLength(0);
		// The line went back to the agent as not said: it writes anew when the user is free.
		f.setBusy(false);
		for (let i = 0; i < 40 && f.calls("compose").length < 2; i++)
			await f.advance(1000);
		expect(f.calls("compose").length).toBeGreaterThanOrEqual(2);
		expect(agencyMessages(f).map((m) => m.text)).not.toContain(
			"fixture held line 1",
		);
	} finally {
		await f.close();
	}
}, 30_000);
