import { expect, test } from "bun:test";
import { createDoclingDocuments, documentDigests } from "../service/documents";
import type {
	DocumentCapabilities,
	SavedDocument,
} from "../contracts/documents";

const id = `wiki-${"a".repeat(32)}`;
const etag = `"${"b".repeat(64)}"`;
const caps: DocumentCapabilities = {
	contractVersion: "larm.docling-files.v1",
	basePath: "/v1/docling/documents",
	requiresDocling: false,
	methods: ["GET", "PUT"],
	maxRequestBytes: 20 * 1024 * 1024,
	maxMarkdownBytes: 8 * 1024 * 1024,
	maxRecoveryBytes: 8 * 1024 * 1024,
	maxPageSize: 100,
	contentDigest: "sha256(ascii(markdownSha256 + LF + recoverySha256))",
};
const markdown = "\uFEFF# 日本語\r\n\r\n末尾の空白  \r\n",
	recovery = '{ "formatVersion": 1, "original": "原文\\r\\n", "bold": true }';
const saved = (md = markdown, rec = recovery): SavedDocument => ({
	id,
	namespace: "eumenes",
	path: "notes/確認.md",
	title: "確認",
	etag,
	markdown: md,
	recovery: rec,
	...documentDigests(md, rec),
});
function fixture(
	over: {
		capabilities?: unknown;
		respond?: (url: URL, init: RequestInit) => Promise<Response>;
	} = {},
) {
	let token = "secret-fixture",
		mutations = 0;
	const calls: {
		path: string;
		headers: Headers;
		method: string;
		body?: string;
	}[] = [];
	const port = createDoclingDocuments({
		connection: () => ({ baseUrl: "https://larm.test/", credential: token }),
		fetch: async (url, init) => {
			calls.push({
				path: url.pathname + url.search,
				headers: new Headers(init.headers),
				method: init.method ?? "GET",
				body: init.body as string | undefined,
			});
			if (url.pathname.endsWith("capabilities"))
				return Response.json(over.capabilities ?? caps);
			if (init.method === "PUT") mutations++;
			if (over.respond) return over.respond(url, init);
			if (url.pathname.endsWith("documents"))
				return Response.json({
					documents: [saved()],
					namespaces: ["eumenes"],
					nextCursor: "page/次+=",
				});
			return Response.json(saved(), {
				status:
					init.method === "PUT" &&
					new Headers(init.headers).has("if-none-match")
						? 201
						: 200,
				headers: { ETag: etag },
			});
		},
	});
	return {
		port,
		calls,
		mutations: () => mutations,
		change: () => {
			token = "other-secret";
		},
	};
}
const signal = () => AbortSignal.timeout(5000);
test("resident listing discovers capabilities and preserves encoded cursors without leases", async () => {
	const h = fixture();
	const page = await h.port.list(signal());
	await h.port.list(signal(), page.nextCursor!);
	expect(h.calls.map((c) => c.path)).toEqual([
		"/v1/docling/capabilities",
		"/v1/docling/documents?limit=100",
		"/v1/docling/documents?limit=100&cursor=page%2F%E6%AC%A1%2B%3D",
	]);
	expect(
		h.calls.every(
			(c) =>
				c.method === "GET" &&
				c.headers.get("authorization") === "Bearer secret-fixture",
		),
	).toBe(true);
});
test("create and update preserve exact strings and the quoted ETag, with only permitted fields", async () => {
	const h = fixture(),
		doc = saved();
	expect(await h.port.read(id, signal())).toEqual(doc);
	await h.port.put(
		id,
		{
			namespace: "eumenes",
			path: doc.path,
			title: doc.title,
			markdown,
			recovery,
		},
		{ kind: "create" },
		signal(),
	);
	await h.port.put(
		id,
		{ markdown, recovery, title: doc.title },
		{ kind: "update", etag },
		signal(),
	);
	const puts = h.calls.filter((c) => c.method === "PUT");
	expect(puts[0]!.headers.get("if-none-match")).toBe("*");
	expect(puts[1]!.headers.get("if-match")).toBe(etag);
	expect(JSON.parse(puts[0]!.body!)).toEqual({
		namespace: "eumenes",
		path: doc.path,
		title: doc.title,
		markdown,
		recovery,
	});
	expect(JSON.parse(puts[1]!.body!)).toEqual({
		markdown,
		recovery,
		title: doc.title,
	});
});
for (const failure of [
	"disconnect",
	"503",
	"412",
	"wrong-digest",
	"wrong-etag",
] as const) {
	test(`PUT ${failure} is classified without any automatic resend`, async () => {
		const h = fixture({
			respond: async (_url, init) => {
				if (failure === "disconnect")
					throw new TypeError("network contains secret upstream details");
				if (failure === "503" || failure === "412")
					return Response.json(
						{
							error: {
								code:
									failure === "503" ? "save_outcome_unknown" : "etag_mismatch",
							},
						},
						{ status: Number(failure) },
					);
				return Response.json(
					{
						...saved(),
						...(failure === "wrong-digest"
							? { markdownSha256: "c".repeat(64) }
							: {}),
					},
					{
						headers: { ETag: failure === "wrong-etag" ? '"other"' : etag },
						status: init.method === "PUT" ? 200 : 200,
					},
				);
			},
		});
		await expect(
			h.port.put(
				id,
				{ markdown, recovery },
				{ kind: "update", etag },
				signal(),
			),
		).rejects.toMatchObject({ uncertain: failure !== "412" });
		expect(h.mutations()).toBe(1);
	});
}
test("contract mismatch and byte limits stop a write before dispatch", async () => {
	const bad = fixture({ capabilities: { ...caps, contractVersion: "other" } });
	await expect(
		bad.port.put(
			id,
			{ markdown, recovery },
			{ kind: "update", etag },
			signal(),
		),
	).rejects.toMatchObject({ code: "docling_contract_unsupported" });
	expect(bad.mutations()).toBe(0);
	const h = fixture({
		capabilities: {
			...caps,
			maxMarkdownBytes: 3,
			maxRecoveryBytes: 8,
			maxRequestBytes: 100,
		},
	});
	await expect(
		h.port.put(
			id,
			{ markdown: "日本", recovery: "" },
			{ kind: "update", etag },
			signal(),
		),
	).rejects.toMatchObject({ code: "invalid_request" });
	await expect(
		h.port.put(
			id,
			{ markdown: "a", recovery: '"'.repeat(8), title: "x".repeat(80) },
			{ kind: "update", etag },
			signal(),
		),
	).rejects.toMatchObject({ code: "payload_too_large" });
	expect(h.mutations()).toBe(0);
});
test("unsafe conditions and update routing fields are refused", async () => {
	const h = fixture();
	for (const etag of ["*", 'W/"x"', '"x","y"', "unquoted"]) {
		await expect(
			h.port.put(
				id,
				{ markdown, recovery },
				{ kind: "update", etag },
				signal(),
			),
		).rejects.toMatchObject({ code: "invalid_request" });
	}
	await expect(
		h.port.put(
			id,
			{ markdown, recovery, namespace: "elsewhere" },
			{ kind: "update", etag },
			signal(),
		),
	).rejects.toMatchObject({ code: "invalid_request" });
	expect(h.mutations()).toBe(0);
});
test("a changed connection fences a late response", async () => {
	let release!: () => void;
	const gate = new Promise<void>((r) => {
		release = r;
	});
	const h = fixture({
		respond: async () => {
			await gate;
			return Response.json(saved(), { headers: { ETag: etag } });
		},
	});
	const pending = h.port.read(id, signal());
	await new Promise((r) => setImmediate(r));
	h.change();
	release();
	await expect(pending).rejects.toMatchObject({
		code: "docling_connection_changed",
	});
});
