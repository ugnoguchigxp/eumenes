import { fixture, document } from "./workspace.fixture";
import { ArchiveFailure } from "../contracts";
import type { LibraryEntry, LibraryCommand } from "../contracts/library";
import { archiveDigest } from "../service/archive-content";
import { createHash } from "node:crypto";
export const docId = `wiki-${"1".repeat(32)}`,
	folderId = `folder-${"a".repeat(32)}`,
	otherId = `wiki-${"2".repeat(32)}`;
export const tag = (v: string) => `"${v.repeat(64)}"`;
export function managementFixture() {
	const h = fixture(),
		raw = "\uFEFF# 日本語\r\n末尾  \r\n",
		recovery = JSON.stringify(document("装飾")),
		digest = archiveDigest(raw, recovery);
	const entries = new Map<string, LibraryEntry>([
		[
			docId,
			{
				kind: "document",
				id: docId,
				namespace: "eumenes",
				path: "元/文書.md",
				title: "原題",
				etag: tag("a"),
				markdownSha256: "a".repeat(64),
				recoverySha256: "b".repeat(64),
				contentDigest: digest,
			},
		],
		[
			folderId,
			{
				kind: "folder",
				id: folderId,
				namespace: "eumenes",
				path: "元",
				name: "元",
				etag: tag("b"),
				documentCount: 1,
				folderCount: 0,
				hasUnsupportedEntries: false,
			},
		],
		[
			otherId,
			{
				kind: "document",
				id: otherId,
				namespace: "eumenes",
				path: "対照.md",
				title: "対照",
				etag: tag("c"),
				markdownSha256: "c".repeat(64),
				recoverySha256: "d".repeat(64),
				contentDigest: "f".repeat(64),
			},
		],
	]);
	h.snapshots.set(docId, {
		entry: {
			sourceId: docId,
			title: "原題",
			namespace: "eumenes",
			path: "元/文書.md",
			revision: tag("a"),
			contentDigest: digest,
		},
		markdown: raw,
		recovery,
	});
	const oldCaps = h.archive.capabilities;
	h.archive.capabilities = async (s) => ({
		...(await oldCaps(s)),
		features: {
			library: true,
			folders: true,
			folderCopy: true,
			patch: true,
			copy: true,
			delete: true,
			createFolder: true,
			recursiveDelete: true,
			batch: true,
			maxBatchItems: 100,
			maxAffectedItems: 500,
			maxCopyBytes: 20971520,
		},
	});
	let calls = 0,
		version = tag("d"),
		fail: "unknown" | "conflict" | null = null,
		pause: Promise<void> | undefined,
		dropAfter = false;
	const commands: LibraryCommand[] = [];
	h.archive.management = {
		async listLibrary(input) {
			return {
				namespace: input.namespace,
				path: input.path,
				etag: version,
				entries: [...entries.values()].filter(
					(e) => e.path.split("/").slice(0, -1).join("/") === input.path,
				),
				nextCursor: null,
			};
		},
		async getEntry(_kind, id) {
			const e = entries.get(id);
			if (!e) throw new ArchiveFailure("markdown_not_found", "failed", 404);
			return e;
		},
		async manage(c) {
			calls++;
			commands.push(c);
			if (pause) await pause;
			if (fail)
				throw new ArchiveFailure(
					"markdown_" +
						(fail === "unknown"
							? "operation_outcome_unknown"
							: "etag_mismatch"),
					fail,
					fail === "unknown" ? 503 : 412,
				);
			const act = c.op === "batch" ? c.action : c.op,
				targets =
					c.op === "batch" ? c.items : c.op === "create-folder" ? [] : [c];
			if (c.op === "create-folder")
				entries.set(c.id, {
					kind: "folder",
					id: c.id,
					namespace: c.namespace,
					path: c.path,
					name: c.path.split("/").at(-1)!,
					etag: tag("e"),
					documentCount: 0,
					folderCount: 0,
					hasUnsupportedEntries: false,
				});
			for (const t of targets) {
				const source = entries.get(t.id);
				if (!source && act === "delete") continue;
				if (!source) throw new Error("missing_fixture_source");
				for (const e of [...entries.values()].filter(
					(e) =>
						e.id === source.id ||
						(source.kind === "folder" && e.path.startsWith(source.path + "/")),
				)) {
					if (act === "delete") {
						entries.delete(e.id);
						continue;
					}
					const dest = "path" in t ? t.path : undefined,
						newId = "newId" in t ? t.newId : undefined;
					const id =
						act === "copy"
							? (e.id === source.id
									? newId!
									: e.kind +
										"-" +
										createHash("sha256")
											.update(newId + "\n" + e.id)
											.digest("hex")
											.slice(0, 32)
								).replace(/^document-/, "wiki-")
							: e.id;
					const path = dest ? dest + e.path.slice(source.path.length) : e.path;
					entries.set(id, {
						...e,
						id,
						path,
						etag: tag("e"),
						...(e.kind === "document" &&
						c.op === "patch" &&
						c.title !== undefined
							? { title: c.title }
							: {}),
						...(e.kind === "folder" ? { name: path.split("/").at(-1)! } : {}),
					});
				}
			}
			version = tag("e");
			if (dropAfter)
				throw new ArchiveFailure(
					"markdown_operation_outcome_unknown",
					"unknown",
					503,
				);
			return {};
		},
	};
	return {
		...h,
		entries,
		raw,
		recovery,
		commands,
		calls: () => calls,
		dropAfter: () => {
			dropAfter = true;
		},
		libraryTag: () => version,
		fail: (v: typeof fail) => {
			fail = v;
		},
		pause: (v: Promise<void> | undefined) => {
			pause = v;
		},
	};
}
