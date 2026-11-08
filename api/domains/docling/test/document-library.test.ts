import { expect, test } from "bun:test";
import {
	createDoclingDocuments,
	documentDigests,
	DocumentFileError,
} from "../service/documents";
import { libraryFeatures, type LibraryCommand } from "../contracts/library";
const doc = `wiki-${"1".repeat(32)}`,
	copy = `wiki-${"2".repeat(32)}`,
	folder = `folder-${"a".repeat(32)}`,
	folderCopy = `folder-${"b".repeat(32)}`,
	etag = `"${"c".repeat(64)}"`,
	libraryTag = `"${"d".repeat(64)}"`;
const old = {
	contractVersion: "larm.docling-files.v1",
	basePath: "/v1/docling/documents",
	requiresDocling: false,
	methods: ["GET", "PUT"],
	maxRequestBytes: 20971520,
	maxMarkdownBytes: 8388608,
	maxRecoveryBytes: 8388608,
	maxPageSize: 100,
	contentDigest: "sha256(ascii(markdownSha256 + LF + recoverySha256))",
};
const extended = {
	...old,
	methods: ["GET", "PUT", "PATCH", "POST", "DELETE", "FUTURE"],
	delete: "exact strong If-Match",
	libraryPath: "/v1/docling/library",
	foldersPath: "/v1/docling/folders",
	operationsPath: "/v1/docling/operations",
	libraryOperations: ["rename", "move", "copy", "delete", "recursive-delete"],
	maxBatchItems: 100,
	maxAffectedItems: 500,
	maxCopyBytes: 20971520,
	folderCopyIds:
		"Descendant ID prefix + first 32 hex of sha256(ascii(newRootId + LF + sourceId))",
	unknown: { future: true },
};
const markdown = "\uFEFF# 日本語\r\n末尾  \r\n",
	recovery = '{ "bold": true, "originalMarkdown": "原文\\r\\n" }';
const saved = (id = doc, path = "元.md", title = "題名") => ({
	id,
	path,
	title,
	namespace: "eumenes",
	etag,
	markdown,
	recovery,
	...documentDigests(markdown, recovery),
});
const dir = (id = folder, path = "元") => ({
	id,
	path,
	name: path.split("/").at(-1),
	namespace: "eumenes",
	etag,
	documentCount: 0,
	folderCount: 0,
	hasUnsupportedEntries: false,
});
function fixture() {
	let caps: unknown = extended,
		now = 0,
		mode: "ok" | "disconnect" | "five" | "conflict" = "ok";
	const calls: { url: URL; init: RequestInit }[] = [];
	const port = createDoclingDocuments({
		connection: () => ({
			baseUrl: "https://larm.test",
			credential: "fixture-backend-secret",
		}),
		now: () => now,
		fetch: async (url, init) => {
			calls.push({ url, init });
			if (url.pathname.endsWith("capabilities")) return Response.json(caps);
			if (init.method && init.method !== "GET") {
				if (mode === "disconnect") throw new Error("response_lost");
				if (mode === "five")
					return Response.json(
						{ error: { code: "operation_outcome_unknown" } },
						{ status: 503 },
					);
				if (mode === "conflict")
					return Response.json(
						{ error: { code: "etag_mismatch" } },
						{ status: 412 },
					);
				const body = init.body ? JSON.parse(String(init.body)) : {};
				if (url.pathname.endsWith("operations"))
					return Response.json({
						namespace: "eumenes",
						etag: libraryTag,
						items: body.items.map(
							(i: { kind: string; id: string; newId?: string }) =>
								body.action === "delete"
									? { kind: i.kind, id: i.id, deleted: true }
									: {
											kind: i.kind,
											id: i.newId ?? i.id,
											sourceId: i.id,
											ids: { [i.id]: i.newId ?? i.id },
										},
						),
					});
				if (init.method === "DELETE")
					return Response.json({
						id: url.pathname.split("/").at(-1),
						deleted: true,
					});
				const copying = url.pathname.endsWith("/copy"),
					id = copying ? body.id : url.pathname.split("/").at(-1),
					status = copying || init.method === "PUT" ? 201 : 200;
				return Response.json(
					url.pathname.includes("/folders/")
						? dir(id, body.path)
						: saved(id, body.path ?? "元.md", body.title ?? "題名"),
					{ status, headers: { ETag: etag } },
				);
			}
			if (url.pathname.endsWith("library"))
				return Response.json({
					namespace: "eumenes",
					path: url.searchParams.get("path") ?? "",
					etag: libraryTag,
					entries: [
						{ kind: "folder", ...dir() },
						{ kind: "document", ...saved() },
					],
					nextCursor: "次/+=",
				});
			if (url.pathname.includes("folders"))
				return Response.json(dir(), { headers: { ETag: etag } });
			return Response.json(saved(), { headers: { ETag: etag } });
		},
	});
	return {
		port,
		calls,
		setCaps: (v: unknown) => {
			caps = v;
		},
		advance: () => {
			now += 61000;
		},
		mode: (v: typeof mode) => {
			mode = v;
		},
	};
}
const signal = () => AbortSignal.timeout(5000);
test("old and future capabilities preserve GET/PUT; extensions appear after cache expiry without probing mutations", async () => {
	const h = fixture();
	h.setCaps({ ...old, methods: ["GET", "PUT", "FUTURE"], unknown: true });
	expect(libraryFeatures(await h.port.capabilities(signal())).library).toBe(
		false,
	);
	expect((await h.port.read(doc, signal())).markdown).toBe(markdown);
	h.setCaps(extended);
	h.advance();
	expect(libraryFeatures(await h.port.capabilities(signal())).batch).toBe(true);
	expect(h.calls.every((c) => !c.init.method)).toBe(true);
});
test("malformed extension metadata disables only affected features", async () => {
	const h = fixture();
	h.setCaps({
		...extended,
		libraryPath: "https://other.invalid/library",
		maxBatchItems: "100",
	});
	const c = await h.port.capabilities(signal());
	expect(libraryFeatures(c).library).toBe(false);
	expect(libraryFeatures(c).batch).toBe(false);
	expect((await h.port.read(doc, signal())).recovery).toBe(recovery);
});
test("hierarchy uses server folder ids, library ETag and an opaque cursor", async () => {
	const h = fixture(),
		r = await h.port.listLibrary(
			{ namespace: "eumenes", path: "", cursor: "次/+= " },
			signal(),
		);
	expect(r.etag).toBe(libraryTag);
	expect(r.entries[0]?.id).toBe(folder);
	expect(h.calls.at(-1)?.url.searchParams.get("cursor")).toBe("次/+= ");
	expect((await h.port.getFolder(folder, signal())).etag).toBe(etag);
});
const cases: {
	command: LibraryCommand;
	method: string;
	path: string;
	body?: unknown;
	condition: string;
}[] = [
	{
		command: {
			op: "patch",
			kind: "document",
			id: doc,
			namespace: "eumenes",
			etag,
			path: "整理/新名.md",
			title: "新題",
		},
		method: "PATCH",
		path: `/v1/docling/documents/${doc}`,
		body: { path: "整理/新名.md", title: "新題" },
		condition: etag,
	},
	{
		command: {
			op: "copy",
			kind: "document",
			id: doc,
			namespace: "eumenes",
			etag,
			newId: copy,
			path: "複写.md",
		},
		method: "POST",
		path: `/v1/docling/documents/${doc}/copy`,
		body: { id: copy, path: "複写.md" },
		condition: etag,
	},
	{
		command: {
			op: "delete",
			kind: "document",
			id: doc,
			namespace: "eumenes",
			etag,
		},
		method: "DELETE",
		path: `/v1/docling/documents/${doc}`,
		condition: etag,
	},
	{
		command: {
			op: "create-folder",
			id: folder,
			namespace: "eumenes",
			path: "空",
		},
		method: "PUT",
		path: `/v1/docling/folders/${folder}`,
		body: { namespace: "eumenes", path: "空" },
		condition: "*",
	},
	{
		command: {
			op: "patch",
			kind: "folder",
			id: folder,
			namespace: "eumenes",
			etag,
			path: "移動",
		},
		method: "PATCH",
		path: `/v1/docling/folders/${folder}`,
		body: { path: "移動" },
		condition: etag,
	},
	{
		command: {
			op: "copy",
			kind: "folder",
			id: folder,
			namespace: "eumenes",
			etag,
			newId: folderCopy,
			path: "複写",
		},
		method: "POST",
		path: `/v1/docling/folders/${folder}/copy`,
		body: { id: folderCopy, path: "複写" },
		condition: etag,
	},
	{
		command: {
			op: "delete",
			kind: "folder",
			id: folder,
			namespace: "eumenes",
			etag,
			recursive: true,
		},
		method: "DELETE",
		path: `/v1/docling/folders/${folder}?recursive=true`,
		condition: etag,
	},
	...(["move", "copy", "delete"] as const).map((action) => ({
		command: {
			op: "batch" as const,
			namespace: "eumenes",
			etag: libraryTag,
			action,
			items: [
				{
					kind: "document" as const,
					id: doc,
					...(action === "delete"
						? {}
						: {
								path: "整理/文書.md",
								...(action === "copy" ? { newId: copy } : {}),
							}),
				},
			],
		},
		method: "POST",
		path: "/v1/docling/operations",
		condition: libraryTag,
	})),
];
for (const c of cases)
	test(`${c.command.op} ${"kind" in c.command ? c.command.kind : "batch/folder"} sends exact conditions and never reserializes content`, async () => {
		const h = fixture();
		const r = await h.port.manage(c.command, signal(), h.port.binding()!);
		const call = h.calls.at(-1)!;
		expect(call.init.method).toBe(c.method);
		expect(call.url.pathname + call.url.search).toBe(c.path);
		expect(
			new Headers(call.init.headers).get(
				c.command.op === "create-folder" ? "if-none-match" : "if-match",
			),
		).toBe(c.condition);
		if (c.body) expect(JSON.parse(String(call.init.body))).toEqual(c.body);
		if (c.command.op === "delete") expect(call.init.body).toBeUndefined();
		expect(String(call.init.body ?? "")).not.toContain("markdown");
		if (c.command.op === "copy" && c.command.kind === "document")
			expect(r).toMatchObject({ id: copy, markdown, recovery });
	});
for (const mode of ["disconnect", "five", "conflict"] as const)
	test(`mutations are single-attempt for ${mode}`, async () => {
		const h = fixture();
		h.mode(mode);
		try {
			await h.port.manage(cases[0]!.command, signal(), h.port.binding()!);
			throw new Error("expected_failure");
		} catch (e) {
			expect(e).toBeInstanceOf(DocumentFileError);
			expect((e as DocumentFileError).uncertain).toBe(mode !== "conflict");
		}
		expect(h.calls.filter((c) => c.init.method === "PATCH")).toHaveLength(1);
	});
test("invalid paths, ETags and unsupported operations never send a mutation", async () => {
	const h = fixture();
	await expect(
		h.port.manage(
			{ ...cases[0]!.command, etag: "*" } as LibraryCommand,
			signal(),
			h.port.binding()!,
		),
	).rejects.toThrow("invalid_request");
	h.setCaps(old);
	await expect(
		h.port.manage(cases[2]!.command, signal(), h.port.binding()!),
	).rejects.toThrow("library_unsupported");
	expect(h.calls.filter((c) => c.init.method)).toHaveLength(0);
});
