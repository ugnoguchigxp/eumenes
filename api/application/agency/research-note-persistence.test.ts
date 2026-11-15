import { expect, test } from "bun:test";
import { waitFor } from "../../infrastructure/wait-for";
import { agendaFixture, replyWith } from "./always-on.fixture";
import { createMarkdown, type ArchivePort } from "../../domains/markdown";
import { createNoteDocuments } from "./note-documents";

const tail =
	"末尾の留保: 地域によって条件が異なるため未確認。\n\n## 出典\n- [一次資料](https://example.com/original)";
const body = `## 比較\n2026-11-15時点。対象は保存方式。\n${"根拠の説明。".repeat(1700)}\n${tail}`;

for (const request of [
	"保存方式を調べてメモにして",
	"保存方式を背景や具体例も含めて長めに説明して",
	"保存方式を一次資料で比較調査し、食い違いと未確認事項も整理して",
]) {
	test(`one preparation entry preserves the request and full note: ${request}`, async () => {
		const prompts: string[] = [];
		const f = await agendaFixture({
			webNote: {
				turn: async (call) => {
					prompts.push(call.prompt);
					return {
						text: `題: 保存方式\n要約: 条件により選び分ける。\n---\n${body}`,
						searches: 1,
						usage: null,
					};
				},
			},
		});
		try {
			await f.start();
			await f.user("user-a", "ao", request);
			const { offered } = await replyWith(f, [
				{
					name: "start_preparation",
					arguments: { request, askedByUser: true },
				},
			]);
			expect(
				offered[0]!.filter((name) => name.startsWith("start_preparation")),
			).toEqual(["start_preparation"]);
			await waitFor(async () => {
				await f.advance(1000);
				return f.host.inspect("ao")!.snapshot.notes.length === 1;
			});
			expect(prompts).toHaveLength(1);
			expect(prompts[0]).toEndWith(`依頼:\n${request}`);
			const note = f.host.inspect("ao")!.snapshot.notes[0]!;
			expect(note.documentId).toBe(f.documents.started[0]!.id);
			expect(note.markdown.length).toBeLessThanOrEqual(8000);
			expect(note.markdown).not.toContain(tail);
			expect(f.documents.started[0]!.markdown).toBe(`# 保存方式\n\n${body}`);
			await f.restart();
			expect(f.documents.started).toHaveLength(1);
			await f.user("user-b");
			const { seen } = await replyWith(
				f,
				[{ name: "read_note", arguments: { id: note.id } }],
				{ runId: "read", messageIds: ["user-b"] },
			);
			// Routine conversation gets the summary; the explicit read gets the original, including its tail.
			expect(seen[0]!.map((m) => m.content).join("\n")).not.toContain(tail);
			const content = seen[1]!.find((m) => m.role === "tool")!.content;
			const read = JSON.parse(
				content.slice(content.indexOf(">") + 1, content.lastIndexOf("<")),
			);
			expect(read.markdown).toBe(`# 保存方式\n\n${body}`);
			// A missing original must never be replaced by the cached preview.
			f.documents.started.splice(0);
			f.documents.originals.clear();
			const missing = await replyWith(
				f,
				[{ name: "read_note", arguments: { id: note.id } }],
				{ runId: "missing", messageIds: ["user-b"] },
			);
			expect(
				missing.seen[1]!.find((m) => m.role === "tool")!.content,
			).not.toContain(note.markdown);
			await f.restart();
			expect(f.documents.started).toHaveLength(0);
		} finally {
			await f.close();
		}
	}, 30_000);
}

test("adoption and the original document roll back together, then recover once", async () => {
	const f = await agendaFixture({
		webNote: {
			turn: async () => ({
				text: `題: 保存方式\n要約: 保存の結論。\n---\n${body}`,
				searches: 1,
				usage: null,
			}),
		},
	});
	const unavailable = async (): Promise<never> => {
		throw new Error("offline");
	};
	const archive: ArchivePort = {
		available: () => false,
		binding: () => null,
		capabilities: unavailable,
		list: unavailable,
		read: unavailable,
		save: unavailable,
	};
	const markdown = createMarkdown({
		store: f.h.store,
		queue: f.h.queue,
		archive,
	});
	f.deps.noteDocuments = createNoteDocuments({
		store: f.h.store,
		markdown,
		ledger: () => undefined,
	});
	const save = f.deps.state.saveInTransaction;
	let rejectAdoption = true;
	let rejected = 0;
	f.deps.state.saveInTransaction = (db, record, at) => {
		if (
			rejectAdoption &&
			(record.snapshot as { notes?: unknown[] }).notes?.length
		) {
			rejected++;
			throw new Error("fixture_checkpoint_failure");
		}
		return save(db, record, at);
	};
	const documents = () =>
		f.h.store.read((db) =>
			db.query("SELECT id FROM markdown_generated").all(),
		) as { id: string }[];
	try {
		await f.start();
		await f.user("user-a");
		await replyWith(f, [
			{
				name: "start_preparation",
				arguments: { request: "保存方式の比較調査", askedByUser: true },
			},
		]);
		await waitFor(async () => {
			await f.advance(1000);
			return rejected > 0;
		});
		expect(documents()).toEqual([]);
		expect(f.host.inspect("ao")!.snapshot.notes).toEqual([]);
		expect(
			f.h.store.read((db) =>
				db.query("SELECT returned FROM dialogue_agency_work").all(),
			),
		).toEqual([{ returned: 0 }]);
		rejectAdoption = false;
		await waitFor(async () => {
			await f.advance(1000);
			return f.host.inspect("ao")!.snapshot.notes.length === 1;
		});
		const note = f.host.inspect("ao")!.snapshot.notes[0]!;
		expect(documents()).toEqual([{ id: note.documentId! }]);
		expect(
			f.h.store.read((db) =>
				markdown.generated.originalInTransaction(db, note.documentId!),
			)?.markdown,
		).toBe(`# 保存方式\n\n${body}`);
		await f.restart();
		expect(documents()).toEqual([{ id: note.documentId! }]);
		expect(
			f.h.store.read((db) =>
				markdown.generated.originalInTransaction(db, note.documentId!),
			)?.markdown,
		).toContain(tail);
	} finally {
		await f.close();
	}
}, 30_000);
