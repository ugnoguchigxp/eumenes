import { expect, test } from "bun:test";
import { waitFor } from "../../infrastructure/wait-for";
import type { WebNoteAttempt, WebNoteTurn } from "../../domains/web-note";
import { agendaFixture, planNothing, type CallKind } from "./always-on.fixture";

const NOTE = [
	"題: 七里ヶ浜の日の出",
	"要約: 11月12日の日の出は6時12分ごろ。",
	"---",
	"## 日の出",
	"2026年11月11日時点では、11月12日の日の出は6:12です。",
	"## 出典",
	"- [気象庁](https://www.jma.go.jp/sunrise)",
].join("\n");

/** The plan that asks for one research about the user's first line. */
function planOnce(topic: string) {
	let planned = false;
	return (kind: CallKind, request: { prompt: string }) => {
		if (kind !== "plan") return undefined;
		if (planned || !request.prompt.includes("user-0")) return planNothing();
		planned = true;
		return {
			add: [
				{
					kind: "research",
					text: topic,
					refs: ["user-0"],
					value: 5,
					reason: "fixture",
					topic,
				},
			],
			drop: [],
			focus: topic,
		};
	};
}

test("the agenda's research ticket starts the web note task, and its note reaches the agent with title, summary, body and sources", async () => {
	const prompts: string[] = [];
	const attempts: WebNoteAttempt[] = [];
	const turn: WebNoteTurn = async (call) => {
		prompts.push(call.prompt);
		return {
			text: NOTE,
			searches: 1,
			usage: { input: 1000, cachedInput: 0, output: 200, reasoning: 50 },
		};
	};
	const f = await agendaFixture({
		script: planOnce("明日の七里ヶ浜の日の出時刻"),
		webNote: {
			turn,
			record: async (attempt) => {
				attempts.push(attempt);
			},
		},
	});
	try {
		await f.start();
		await f.user("user-0");
		await waitFor(async () => {
			await f.advance(1000);
			return f.host.inspect("ao")!.snapshot.notes.length === 1;
		});
		// The ticket went to the web note toolchain, not the deep research.
		const works = f.h.store.read((db) =>
			db.query("SELECT toolchain_revision_id FROM dialogue_agency_work").all(),
		) as Array<{ toolchain_revision_id: string }>;
		expect(works.map((w) => w.toolchain_revision_id)).toEqual([
			"toolchain:web.note@1",
		]);
		expect(prompts).toHaveLength(1);
		expect(prompts[0]).toContain("依頼:\n明日の七里ヶ浜の日の出時刻");
		const [note] = f.host.inspect("ao")!.snapshot.notes;
		expect(note).toMatchObject({
			title: "七里ヶ浜の日の出",
			summary: "11月12日の日の出は6時12分ごろ。",
			ticketId: expect.any(String),
		});
		expect(note!.markdown).toContain("# 七里ヶ浜の日の出");
		expect(note!.markdown).toContain("11月12日の日の出は6:12");
		// The source is in the body once, not listed again.
		expect(note!.markdown.match(/jma\.go\.jp/g)).toHaveLength(1);
		expect(attempts).toHaveLength(1);
		expect(attempts[0]).toMatchObject({ status: "succeeded" });
	} finally {
		await f.close();
	}
}, 30_000);

test("a research that cannot be done is a failed research for the agent, with no note", async () => {
	const f = await agendaFixture({
		script: planOnce("明日の七里ヶ浜の日の出時刻"),
		webNote: {
			turn: async () => {
				throw new Error("Codex Exec exited with code 1: sign in required");
			},
		},
	});
	try {
		await f.start();
		await f.user("user-0");
		await waitFor(async () => {
			await f.advance(1000);
			const rows = f.h.store.read((db) =>
				db.query("SELECT returned FROM dialogue_agency_work").all(),
			) as Array<{ returned: number }>;
			return rows.length === 1 && rows[0]!.returned === 1;
		});
		expect(f.host.inspect("ao")!.snapshot.notes).toHaveLength(0);
	} finally {
		await f.close();
	}
}, 30_000);

test("a research whose run is gone at its owner ends: its ticket comes back failed and its TODO is closed, not left open", async () => {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const f = await agendaFixture({
		script: planOnce("明日の七里ヶ浜の日の出時刻"),
		webNote: {
			turn: async () => {
				await gate;
				return { text: NOTE, searches: 1, usage: null };
			},
		},
	});
	const works = () =>
		f.h.store.read((db) =>
			db
				.query(
					"SELECT execution_id,toolchain_revision_id,returned FROM dialogue_agency_work",
				)
				.all(),
		) as Array<{
			execution_id: string | null;
			toolchain_revision_id: string;
			returned: number;
		}>;
	try {
		await f.start();
		await f.user("user-0");
		await waitFor(async () => {
			await f.advance(1000);
			return !!works()[0]?.execution_id;
		});
		// The work is a TODO of the conversation while it runs.
		expect(f.h.todos("ao")).toHaveLength(1);
		expect(f.host.inspect("ao")!.snapshot.tickets).toHaveLength(1);
		const [work] = works();
		// The owner drops the run on its own (its origin stopped being valid): no result will ever come.
		await f.h.store.write((db) =>
			f.h.routing.taskInTransaction!(db, work!.toolchain_revision_id)!
				.forgetInTransaction!(db, work!.execution_id!),
		);
		await waitFor(async () => {
			await f.advance(1000);
			return works()[0]!.returned === 1;
		});
		expect(f.host.inspect("ao")!.snapshot.tickets).toHaveLength(0);
		expect(f.host.inspect("ao")!.snapshot.notes).toHaveLength(0);
		expect(f.h.todos("ao")).toHaveLength(0);
	} finally {
		release();
		await f.close();
	}
}, 30_000);

test("without a Codex executable the research toolchain is not offered and the research cannot start", async () => {
	const f = await agendaFixture({ script: planOnce("明日の天気") });
	try {
		const catalog = f.h.store.read((db) => f.port.catalogInTransaction(db));
		expect(
			catalog.some((c) => c.revisionId.startsWith("toolchain:web.note@")),
		).toBe(false);
		// The research is not handed to another capability: it fails for the agent, and no note comes of it.
		await f.start();
		await f.user("user-0");
		await waitFor(async () => {
			await f.advance(1000);
			return f.kinds.filter((k) => k === "plan").length >= 2;
		});
		for (let k = 0; k < 3; k++) await f.advance(1000);
		expect(f.host.inspect("ao")!.snapshot.notes).toHaveLength(0);
		const works = f.h.store.read((db) =>
			db.query("SELECT 1 FROM dialogue_agency_work").all(),
		);
		expect(works).toHaveLength(0);
	} finally {
		await f.close();
	}
}, 30_000);
