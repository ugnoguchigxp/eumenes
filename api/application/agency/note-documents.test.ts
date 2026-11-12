import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { harness } from "../toolchain/toolchain.fixture";
import { createScratchStore } from "../../domains/scratch";
import type { ArchivePort } from "../../domains/markdown";
import type { ArchivedDocument } from "../../domains/markdown/contracts";
import { waitFor } from "../../infrastructure/wait-for";
import { createNoteDocuments } from "./note-documents";

const NOTE = {
	conversationId: "main",
	noteId: "n1a2b3c4",
	title: "鎌倉の天気",
	markdown:
		"# 鎌倉の天気\n\n2026-11-12 は晴れ。\n\n- [出典](https://example.com/weather)",
	// 01:30 on 2026-11-12 in Japan: the day the document is filed under is the user's, not UTC's.
	at: Date.parse("2026-11-11T16:30:00Z"),
};

for (const online of [true, false]) {
	test(`a note is a document of the Markdown domain: a local Markdown file, the library when connected (filed by day), the chip of its message; forgetting takes the local file and the record, never the library's document (online=${online})`, async () => {
		const dir = mkdtempSync(join(tmpdir(), "eumenes-note-document-")),
			scratch = createScratchStore({
				root: dir,
				freeBytes: () => 20 * 1024 ** 3,
			});
		scratch.start();
		const saved = new Map<string, ArchivedDocument>();
		const archive: ArchivePort = {
			binding: () => (online ? "fixture" : null),
			available: () => online,
			capabilities: async () => ({
				maxMarkdownBytes: 8388608,
				maxRecoveryBytes: 8388608,
				maxRequestBytes: 20971520,
				maxPageSize: 100,
			}),
			list: async () => ({
				items: [...saved.values()].map((d) => d.entry),
				namespaces: ["eumenes"],
				nextCursor: null,
			}),
			read: async (id) => saved.get(id)!,
			save: async (input) => {
				const document = {
					markdown: input.markdown,
					recovery: input.recovery,
					entry: {
						sourceId: input.sourceId,
						title: input.title,
						namespace: input.namespace,
						path: input.path,
						contentDigest: input.contentDigest,
						revision: `"${"a".repeat(64)}"`,
					},
				};
				saved.set(input.sourceId, document);
				return document.entry;
			},
		};
		const h = await harness({ scratch, markdown: archive, resources: true });
		try {
			// Nothing asks whether the agent still holds the note: one its list let go keeps its document.
			const documents = createNoteDocuments({
				store: h.store,
				markdown: h.markdown!,
				scratch,
				ledger: () => h.dialogue.resourceLedger,
			});
			const id = await h.store.write((db) =>
				documents.startInTransaction(db, NOTE),
			);
			// The same note is the same document: nothing is saved twice.
			expect(
				await h.store.write((db) => documents.startInTransaction(db, NOTE)),
			).toBe(id);
			const state = () =>
				h.store.read((db) => documents.stateInTransaction(db, id));
			await waitFor(() => state() !== "pending");
			const uri = `eumenes://markdown.document/generated-${id}`;
			expect(state()).toEqual({ uri, label: NOTE.title });
			// The local file is the note's Markdown, byte for byte.
			const content = await h.request(`/api/scratch/${id}/content`);
			expect(await content.text()).toBe(NOTE.markdown);
			expect(scratch.get(id)?.name).toBe("鎌倉の天気.md");
			// The document is the chip of the message that shows the note.
			const message = { id: "agency-note:fixture" };
			await h.store.write((db) =>
				h.conversation.appendInTransaction(db, {
					id: message.id,
					conversationId: "main",
					role: "assistant",
					text: NOTE.title,
					createdAt: new Date().toISOString(),
					runId: null,
				}),
			);
			await h.store.write((db) =>
				documents.linkInTransaction(db, {
					conversationId: "main",
					messageId: message.id,
					uri,
					label: NOTE.title,
				}),
			);
			const resources = await (
				await h.request("/api/conversations/main/resources")
			).json();
			expect(resources.resources).toEqual([
				expect.objectContaining({
					uri,
					kind: "markdown.document",
					label: NOTE.title,
				}),
			]);
			expect(resources.messages).toEqual([
				{ messageId: message.id, uris: [uri] },
			]);
			// The screen opens it in the Markdown view: the library's document, or the local file read-only.
			const source = await (
				await h.request(
					`/api/toolchain-artifacts/${encodeURIComponent("artifact:markdown.workspace@4")}/sources/markdown-workspace?target=generated-${id}`,
				)
			).json();
			if (online) {
				const remote = [...saved.values()][0]!;
				expect(remote.markdown).toBe(NOTE.markdown);
				expect(remote.entry.path).toBe(
					"notes/2026-11-12_鎌倉の天気_n1a2b3c4.md",
				);
				expect(source).toMatchObject({
					data: { openSourceId: remote.entry.sourceId },
				});
			} else
				expect(source).toMatchObject({
					data: { preview: { title: NOTE.title, markdown: NOTE.markdown } },
				});
			// Forgotten: the local file and the record go; the library's document stays the user's.
			documents.forget("main", [NOTE.noteId]);
			expect(scratch.get(id)).toBeNull();
			await waitFor(() => {
				const now = state();
				return now !== "pending" && "code" in now;
			});
			expect(
				(
					await h.request(
						`/api/resources/resolve?uri=${encodeURIComponent(uri)}`,
					)
				).status,
			).toBe(404);
			expect(saved.size).toBe(online ? 1 : 0);
		} finally {
			await h.close();
			scratch.close();
			rmSync(dir, { recursive: true, force: true });
		}
	}, 20000);
}
