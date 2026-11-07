import { afterEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createScratchStore } from "../service/store";
import { readPage, noteOf } from "../service/describe";
import { createScratchResourceAdapter } from "../service/resource-adapter";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
function setup(
	options: Partial<Parameters<typeof createScratchStore>[0]> = {},
) {
	const root = mkdtempSync(join(tmpdir(), "scratch-"));
	roots.push(root);
	let clock = 1_000;
	let next = 0;
	const store = createScratchStore({
		root,
		bootId: "boot",
		now: () => clock,
		id: () => `00000000-0000-4000-8000-${String(++next).padStart(12, "0")}`,
		freeBytes: () => null,
		...options,
	});
	return {
		root,
		store,
		tick: (ms = 1) => {
			clock += ms;
		},
	};
}
const text = (s: string) => new TextEncoder().encode(s);
const put = (
	store: ReturnType<typeof createScratchStore>,
	name: string,
	data: Uint8Array,
	conversationId = "main",
) =>
	store.put({
		conversationId,
		name,
		mime: "text/plain",
		data,
		origin: "written",
		maker: "Web調査",
	});

describe("scratch store", () => {
	test("stores under the boot directory and reads the content back", async () => {
		const { root, store } = setup();
		const item = await put(store, "memo.txt", text("hello"));
		expect(existsSync(join(root, "boot", item.id))).toBe(true);
		expect(new TextDecoder().decode(await store.bytes(item.id))).toBe("hello");
		expect(store.usage()).toEqual({ items: 1, bytes: 5 });
	});

	test("the same conversation and content return the stored item; an own id is idempotent", async () => {
		const { store, tick } = setup();
		const first = await put(store, "a.txt", text("same"));
		tick();
		const again = await put(store, "b.txt", text("same"));
		expect(again.id).toBe(first.id);
		expect(again.usedAt).toBe(1_001);
		expect((await put(store, "a.txt", text("same"), "other")).id).not.toBe(
			first.id,
		);
		const id = "11111111-1111-4111-8111-111111111111";
		const own = {
			conversationId: "main",
			name: "img.png",
			mime: "image/png" as const,
			origin: "attached" as const,
			maker: "利用者",
		};
		await store.put({ ...own, id, data: text("png") });
		expect((await store.put({ ...own, id, data: text("png") })).id).toBe(id);
		await expect(
			store.put({ ...own, id, data: text("other") }),
		).rejects.toThrow("request_conflict");
	});

	test("rejects unsupported types, empty data, bad names and oversized items", async () => {
		const { store } = setup({ limits: { itemBytes: 4 } });
		const base = {
			conversationId: "main",
			origin: "written" as const,
			maker: "x",
		};
		await expect(
			store.put({
				...base,
				name: "x.svg",
				mime: "image/svg+xml" as never,
				data: text("a"),
			}),
		).rejects.toThrow("scratch_type_unsupported");
		await expect(
			store.put({
				...base,
				name: "x.txt",
				mime: "text/plain",
				data: new Uint8Array(),
			}),
		).rejects.toThrow("scratch_empty");
		await expect(
			store.put({ ...base, name: "  ", mime: "text/plain", data: text("a") }),
		).rejects.toThrow("scratch_name_invalid");
		await expect(
			store.put({
				...base,
				name: "x.txt",
				mime: "text/plain",
				data: text("abcde"),
			}),
		).rejects.toThrow("scratch_too_large");
		const item = await store.put({
			...base,
			name: "a\nb\u0007c",
			mime: "text/plain",
			data: text("a"),
		});
		expect(item.name).toBe("a b c");
	});

	test("evicts least recently used items down to the target, skipping leased ones", async () => {
		const { store, tick } = setup({
			limits: { capacityBytes: 40, targetBytes: 30 },
		});
		const a = await put(store, "a", text("a".repeat(10)));
		tick();
		const b = await put(store, "b", text("b".repeat(10)));
		tick();
		const c = await put(store, "c", text("c".repeat(10)));
		tick();
		const d = await put(store, "d", text("d".repeat(10)));
		tick();
		store.touch(a.id);
		const release = store.lease(b.id);
		tick();
		// 40 + 10 > 40: evict until 10 more fit under 30. b is leased and a was used last: c and d go.
		const e = await put(store, "e", text("e".repeat(10)));
		expect([a, b, c, d, e].map((i) => store.get(i.id) !== null)).toEqual([
			true,
			true,
			false,
			false,
			true,
		]);
		release();
		tick();
		await put(store, "f", text("f".repeat(10)));
		await put(store, "g", text("g".repeat(10)));
		expect(store.get(b.id)).toBeNull();
	});

	test("a write that cannot fit because everything is leased is refused", async () => {
		const { store } = setup({ limits: { capacityBytes: 20, targetBytes: 10 } });
		const a = await put(store, "a", text("a".repeat(10)));
		const b = await put(store, "b", text("b".repeat(10)));
		store.lease(a.id);
		store.lease(b.id);
		await expect(put(store, "c", text("c".repeat(10)))).rejects.toThrow(
			"scratch_capacity",
		);
		expect(store.usage().items).toBe(2);
	});

	test("an expired lease no longer protects the item", async () => {
		const { store, tick } = setup({
			limits: { capacityBytes: 10, targetBytes: 10, leaseMs: 5 },
		});
		const a = await put(store, "a", text("a".repeat(10)));
		store.lease(a.id);
		tick(6);
		await put(store, "b", text("b".repeat(10)));
		expect(store.get(a.id)).toBeNull();
	});

	test("low free space on the volume counts as over capacity", async () => {
		let free = 100;
		const { store, tick } = setup({
			limits: { minFreeBytes: 95 },
			freeBytes: () => free,
		});
		const a = await put(store, "a", text("a".repeat(3)));
		tick();
		free = 97;
		// 97 - 3 < 95: the oldest item goes even though the store is far below its capacity.
		await put(store, "b", text("b".repeat(3)));
		expect(store.get(a.id)).toBeNull();
	});

	test("the item count is bounded", async () => {
		const { store, tick } = setup({ limits: { items: 2 } });
		const a = await put(store, "a", text("a"));
		tick();
		await put(store, "b", text("b"));
		tick();
		await put(store, "c", text("c"));
		expect(store.get(a.id)).toBeNull();
		expect(store.usage().items).toBe(2);
	});

	test("start removes every other boot's directory; close removes its own", async () => {
		const { root, store } = setup();
		mkdirSync(join(root, "old-boot"), { recursive: true });
		writeFileSync(join(root, "old-boot", "x"), "left");
		store.start();
		for (let i = 0; i < 50 && existsSync(join(root, "old-boot")); i++)
			await Bun.sleep(10);
		expect(existsSync(join(root, "old-boot"))).toBe(false);
		const item = await put(store, "a", text("a"));
		store.close();
		expect(existsSync(join(root, "boot"))).toBe(false);
		expect(store.get(item.id)).toBeNull();
	});

	test("concurrent puts of one id store it once and count its bytes once", async () => {
		const { store } = setup();
		const id = "88888888-8888-4888-8888-888888888888";
		const one = () =>
			store.put({
				id,
				conversationId: "main",
				name: "img.png",
				mime: "image/png",
				data: text("x".repeat(11_000)),
				origin: "attached",
				maker: "利用者",
			});
		const all = await Promise.all([one(), one(), one()]);
		expect(new Set(all.map((i) => i.id))).toEqual(new Set([id]));
		expect(store.usage()).toEqual({ items: 1, bytes: 11_000 });
		// The same content without an id, written twice at once, is one item too.
		await Promise.all([
			put(store, "a", text("same")),
			put(store, "b", text("same")),
		]);
		expect(store.usage()).toEqual({ items: 2, bytes: 11_004 });
	});

	test("a write eviction cannot make room for is refused before anything is evicted", async () => {
		let free = 10_000;
		const { store } = setup({
			limits: { minFreeBytes: 1_000 },
			freeBytes: () => free,
		});
		const a = await put(store, "a", text("a".repeat(100)));
		// 500 free and 100 in the store: evicting all of it still leaves the volume under its minimum.
		free = 500;
		await expect(put(store, "b", text("b"))).rejects.toThrow(
			"scratch_capacity",
		);
		expect(store.get(a.id)).not.toBeNull();
	});

	test("a long name keeps its first 120 characters", async () => {
		const { store } = setup();
		const item = await put(store, `${"長".repeat(150)}.md`, text("a"));
		expect(item.name).toBe("長".repeat(120));
	});

	test("lists a conversation's items most recently used first", async () => {
		const { store, tick } = setup();
		const a = await put(store, "a", text("a"));
		tick();
		const b = await put(store, "b", text("b"));
		await put(store, "c", text("c"), "other");
		tick();
		store.touch(a.id);
		expect(store.list("main").map((i) => i.id)).toEqual([a.id, b.id]);
	});
});

describe("scratch reads", () => {
	test("a text item pages by byte position from a window of the file, never cutting a character", async () => {
		const { store } = setup();
		// Mixed widths: 1-byte, 3-byte and 4-byte (surrogate pair) characters across page edges.
		const body = "abc あいう 𩸽 漢字。\n".repeat(600);
		const bytes = text(body);
		const item = await put(store, "議事録.md", bytes);
		const adapter = createScratchResourceAdapter(store);
		const read = (offset?: number) =>
			adapter
				.read(
					item.id,
					AbortSignal.timeout(1000),
					offset === undefined ? undefined : { offset },
				)
				.then((r) => r.text);
		const first = await read();
		const next = /\n続き: offset (\d+)$/.exec(first);
		expect(next).not.toBeNull();
		expect(first.split("\n")[0]).toContain(
			`位置 0〜${next![1]}／全 ${bytes.length}`,
		);
		const bodyOf = (page: string) =>
			page.slice(page.indexOf("\n") + 1).replace(/\n続き: offset \d+$/, "");
		const pages = [bodyOf(first)];
		let at = Number(next![1]);
		while (at < bytes.length) {
			const page = await read(at);
			pages.push(bodyOf(page));
			const more = /\n続き: offset (\d+)$/.exec(page);
			at = more ? Number(more[1]) : bytes.length;
		}
		expect(pages.length).toBeGreaterThan(2);
		expect(pages.join("")).toBe(body);
		expect(pages.join("")).not.toContain("\ufffd");
		// A position inside a character moves on to the next one.
		expect(bodyOf(await read(5)).startsWith("いう")).toBe(true);
		expect(await read(bytes.length + 10)).toContain("（ここで終わりです）");
	});

	test("only the page's bytes are read, whatever the file's size", async () => {
		const { store } = setup();
		const item = await put(
			store,
			"大きい.csv",
			text("a,b\n".repeat(2_000_000)),
		);
		const adapter = createScratchResourceAdapter(store);
		const started = performance.now();
		const page = (
			await adapter.read(item.id, AbortSignal.timeout(1000), {
				offset: 4_000_000,
			})
		).text;
		expect(performance.now() - started).toBeLessThan(200);
		expect(page).toContain("位置 4000000〜");
	});

	test("an image is described, with its note and annotation", async () => {
		const { store } = setup();
		const item = await store.put({
			conversationId: "main",
			name: "IMG_2041.jpg",
			mime: "image/jpeg",
			data: text("jpeg"),
			origin: "attached",
			maker: "利用者",
			width: 1600,
			height: 1200,
			annotation: { source: "物体認識", data: { cup: 0.91 } },
		});
		expect(noteOf(item)).toBe("利用者が添付、画像 1600×1200");
		const page = readPage(item, null);
		expect(page).toContain("種類: 画像（image/jpeg、1600×1200、4B）");
		expect(page).toContain('注記（物体認識）: {"cup":0.91}');
		expect(page).toContain("サーバーの再起動で消えます。");
		const adapter = createScratchResourceAdapter(store);
		const view = adapter.getInTransaction(null as never, item.id)!;
		expect(view.uri).toBe(`eumenes://scratch/${item.id}`);
		expect(view.preview).toBe(`/api/scratch/${item.id}/content`);
		expect(view.note).toBe("利用者が添付、画像 1600×1200");
	});

	test("a written text's note names its maker and size", async () => {
		const { store } = setup();
		const item = await store.put({
			conversationId: "main",
			name: "競合3社の価格表.md",
			mime: "text/markdown",
			data: text("x".repeat(8 * 1024)),
			origin: "written",
			maker: "Web調査",
		});
		expect(noteOf(item)).toBe("Web調査が作成、Markdown 8KB");
	});

	test("a result names the files the work wrote, only the same conversation's", async () => {
		const { store } = setup();
		const put = (conversationId: string, origin: "written" | "attached") =>
			store.put({
				conversationId,
				name: `${origin}.md`,
				mime: "text/markdown",
				data: text(`${conversationId} ${origin}`),
				origin,
				maker: origin === "written" ? "計算" : "利用者",
			});
		const written = await put("main", "written");
		const attached = await put("main", "attached");
		const other = await put("other", "written");
		const adapter = createScratchResourceAdapter(store);
		const refs = (result: unknown) =>
			adapter
				.fromResultInTransaction(null as never, result, {
					conversationId: "main",
				})
				.map((ref) => ref.uri);
		const uri = (id: string) => `eumenes://scratch/${id}`;
		expect(
			refs({
				summary: `表は ${uri(written.id)} です。`,
				files: [{ uri: uri(written.id) }, uri(attached.id), uri(other.id)],
			}),
		).toEqual([uri(written.id)]);
		expect(refs({ uri: uri("00000000-0000-4000-8000-999999999999") })).toEqual(
			[],
		);
		expect(refs("nothing")).toEqual([]);
		expect(refs(null)).toEqual([]);
	});
});
