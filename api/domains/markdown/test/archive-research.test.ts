import { expect, test } from "bun:test";
import type { ArchivePort } from "../contracts";
import { createArchiveResearch } from "../service/archive-research";

const entry = {
	sourceId: "wiki-0123456789abcdef0123456789abcdef",
	title: "Quarterly schedule",
	revision: '"v1"',
	path: "team/schedule.md",
	namespace: "reports",
	contentDigest: "digest",
};
const opening = "a".repeat(1599);
const body = `${opening}📝\r\nSecond section\r\n`;

function fixture() {
	let binding = "archive-a";
	let selected = entry;
	const archive: ArchivePort = {
		available: () => true,
		binding: () => binding,
		list: async () => ({
			items: [entry],
			namespaces: ["reports"],
			nextCursor: "continue",
		}),
		read: async () => ({ entry: selected, markdown: body, recovery: "unused" }),
		capabilities: async () => ({
			maxMarkdownBytes: 80000,
			maxRecoveryBytes: 80000,
			maxRequestBytes: 160000,
			maxPageSize: 50,
		}),
		save: async () => {
			throw new Error("unexpected write");
		},
	};
	return {
		research: createArchiveResearch(archive),
		replaceRevision: () => {
			selected = { ...entry, revision: '"v2"' };
		},
		switchBinding: () => {
			binding = "archive-b";
		},
	};
}
const signal = () => new AbortController().signal;
const request = {
	binding: "archive-a",
	sourceId: entry.sourceId,
	revision: entry.revision,
};

test("archive search reports the actual page coverage and read offsets follow the original normalized text", async () => {
	const { research } = fixture();
	expect(
		await research.search(
			"archive-a",
			["ＳＣＨＥＤＵＬＥ"],
			undefined,
			signal(),
		),
	).toEqual({
		items: [entry],
		scanned: 1,
		omitted: 0,
		nextCursor: "continue",
	});
	expect(
		await research.search("archive-a", ["other"], undefined, signal()),
	).toEqual({
		items: [],
		scanned: 1,
		omitted: 0,
		nextCursor: "continue",
	});
	const first = await research.read({ ...request, offset: 0 }, signal());
	expect(first).toMatchObject({
		body: opening,
		start: 0,
		end: 1599,
		nextOffset: 1599,
	});
	const second = await research.read(
		{ ...request, offset: first.nextOffset! },
		signal(),
	);
	expect(second).toMatchObject({
		body: "📝\nSecond section\n",
		start: 1599,
		end: body.replaceAll("\r\n", "\n").length,
		nextOffset: null,
	});
});

test("a document grant cannot read a newer revision or a replacement archive", async () => {
	const f = fixture();
	f.replaceRevision();
	await expect(
		f.research.read({ ...request, offset: 0 }, signal()),
	).rejects.toThrow("revision_conflict");
	f.switchBinding();
	await expect(
		f.research.read({ ...request, offset: 0 }, signal()),
	).rejects.toThrow("markdown_archive_binding_changed");
});
