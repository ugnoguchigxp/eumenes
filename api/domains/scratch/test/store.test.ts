import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createScratchStore } from "../service/store";
import { readPage, noteOf } from "../service/describe";
import { createScratchResourceAdapter } from "../service/resource-adapter";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function setup(options: Partial<Parameters<typeof createScratchStore>[0]> = {}) {
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
		expect((await put(store, "a.txt", text("same"), "other")).id).not.toBe(first.id);
		const id = "11111111-1111-4111-8111-111111111111";
		const own = { conversationId: "main", name: "img.png", mime: "image/png" as const, origin: "attached" as const, maker: "利用者" };
		await store.put({ ...own, id, data: text("png") });
		expect((await store.put({ ...own, id, data: text("png") })).id).toBe(id);
		await expect(store.put({ ...own, id, data: text("other") })).rejects.toThrow("request_conflict");
	});

	test("rejects unsupported types, empty data, bad names and oversized items", async () => {
		const { store } = setup({ limits: { itemBytes: 4 } });
		const base = { conversationId: "main", origin: "written" as const, maker: "x" };
		await expect(store.put({ ...base, name: "x.svg", mime: "image/svg+xml" as never, data: text("a") })).rejects.toThrow("scratch_type_unsupported");
		await expect(store.put({ ...base, name: "x.txt", mime: "text/plain", data: new Uint8Array() })).rejects.toThrow("scratch_empty");
		await expect(store.put({ ...base, name: "  ", mime: "text/plain", data: text("a") })).rejects.toThrow("scratch_name_invalid");
		await expect(store.put({ ...base, name: "x.txt", mime: "text/plain", data: text("abcde") })).rejects.toThrow("scratch_too_large");
		const item = await store.put({ ...base, name: "a\nb\u0007c", mime: "text/plain", data: text("a") });
		expect(item.name).toBe("a b c");
	});

	test("evicts least recently used items down to the target, skipping leased ones", async () => {
		const { store, tick } = setup({ limits: { capacityBytes: 40, targetBytes: 30 } });
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
		await expect(put(store, "c", text("c".repeat(10)))).rejects.toThrow("scratch_capacity");
		expect(store.usage().items).toBe(2);
	});

	test("an expired lease no longer protects the item", async () => {
		const { store, tick } = setup({ limits: { capacityBytes: 10, targetBytes: 10, leaseMs: 5 } });
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
	test("a text item pages by characters with the offset of the rest", async () => {
		const { store } = setup();
		const body = "あ".repeat(3000);
		const item = await put(store, "議事録.md", text(body));
		const adapter = createScratchResourceAdapter(store);
		const first = (await adapter.read(item.id, AbortSignal.timeout(1000))).text;
		const next = /続き: offset (\d+)$/.exec(first);
		expect(next).not.toBeNull();
		const offset = Number(next![1]);
		expect(offset).toBeGreaterThan(0);
		expect(first.split("\n")[0]).toContain(`0〜${offset.toLocaleString("en-US")}字／全3,000字`);
		const pages = [first];
		let at = offset;
		while (at < 3000) {
			const page = (await adapter.read(item.id, AbortSignal.timeout(1000), { offset: at })).text;
			pages.push(page);
			const more = /続き: offset (\d+)$/.exec(page);
			at = more ? Number(more[1]) : 3000;
		}
		const joined = pages.map((p) => p.split("\n")[1]).join("");
		expect(joined).toBe(body);
		expect(
			(await adapter.read(item.id, AbortSignal.timeout(1000), { offset: 5000 })).text,
		).toContain("（ここで終わりです）");
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
});
