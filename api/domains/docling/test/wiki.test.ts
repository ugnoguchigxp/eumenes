import { expect, test } from "bun:test";
import { createDoclingWiki } from "../service/wiki";
import type { DoclingConnection, DoclingFetch } from "..";
const id = "3ef85c71-eedc-42c0-b21b-0adf9d28e35c";
function fixture(mode = "normal") {
	let connection: DoclingConnection | null = {
		revision: 1,
		version: "v1",
		gatewayUrl: "http://127.0.0.1:28765",
		publicOrigin: "http://localhost:28765",
		credential: "backend-fixture-secret",
	};
	let body = "",
		revision = "r1",
		posts = 0;
	const entry = () => ({
		id: "article-id",
		namespace: "Eumenes",
		path: `${id}.md`,
		title: "保存文書",
		revision,
	});
	const wiki = createDoclingWiki({
		connection: () => connection,
		fetch: (async (url, init) => {
			expect(new Headers(init?.headers).get("Authorization")).toBe(
				"Bearer backend-fixture-secret",
			);
			expect(init?.redirect).toBe("manual");
			if (init?.method === "POST") {
				posts++;
				const form = init.body as FormData;
				expect(form.get("namespace")).toBe("Eumenes");
				expect(JSON.parse(await (form.get("manifest") as File).text())).toEqual(
					{
						articles: { [`${id}.md`]: { title: "保存文書", external_key: id } },
					},
				);
				body = await (form.get("files") as File).text();
				revision = "r2";
				if (mode === "lost-response") throw new Error("connection reset");
				if (mode === "config-changed") connection = null;
				return Response.json({ articles: [entry()] }, { status: 201 });
			}
			if (String(url).endsWith("/catalog"))
				return Response.json({ articles: body ? [entry()] : [] });
			return new Response(
				mode === "changed-readback" ? "different content" : body,
			);
		}) as DoclingFetch,
	});
	return { wiki, posts: () => posts };
}
const signal = () => new AbortController().signal;
const input = {
	documentId: id,
	title: "保存文書",
	text: "# 日本語の文書\r\n\r\n本文",
	sourceId: null,
	remoteRevision: null,
	binding: "v1",
};
test.each(["normal", "lost-response"])(
	"Desk API %s performs one import, verifies body, and updates same source",
	async (mode) => {
		const h = fixture(mode);
		const first = await h.wiki.save(input, signal());
		expect(first.id).toBe("article-id");
		expect(h.posts()).toBe(1);
		const second = await h.wiki.save(
			{
				...input,
				sourceId: first.id,
				remoteRevision: first.revision,
				text: input.text + "追記",
			},
			signal(),
		);
		expect(second.id).toBe(first.id);
		expect(h.posts()).toBe(2);
	},
);
test("changed remote revision is refused before another POST", async () => {
	const h = fixture();
	await h.wiki.save(input, signal());
	await expect(h.wiki.save(input, signal())).rejects.toThrow(
		"docling_document_conflict",
	);
	expect(h.posts()).toBe(1);
});
test.each(["changed-readback", "config-changed"])(
	"Desk %s never returns confirmed save",
	async (mode) => {
		const h = fixture(mode);
		await expect(h.wiki.save(input, signal())).rejects.toThrow(
			"docling_document_unconfirmed",
		);
		expect(h.posts()).toBe(1);
	},
);
test("configuration changed before dispatch refuses the write", async () => {
	const h = fixture();
	await expect(
		h.wiki.save({ ...input, binding: "old" }, signal()),
	).rejects.toThrow("docling_connection_changed");
	expect(h.posts()).toBe(0);
});
