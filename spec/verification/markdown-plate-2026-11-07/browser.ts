import { chromium } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { openStore } from "./store";

const directory = import.meta.dir;
const out = `${directory}/results`;
await mkdir(out, { recursive: true });
const buildDirectory = resolve("verification-reports/markdown-plate-2026-11-07");
await mkdir(buildDirectory, { recursive: true });
const build = await Bun.build({ entrypoints: [`${directory}/lab.tsx`], target: "browser", minify: true, define: { "process.env.NODE_ENV": '"production"' } });
if (!build.success) throw new Error(String(build.logs));
const script = await build.outputs[0]!.text();
await writeFile(`${buildDirectory}/lab.html`, '<!doctype html><meta charset="utf-8"><title>Plate verification</title><style>body{font:18px sans-serif;padding:24px;background:#181a20;color:#eee} [contenteditable]{min-height:240px;border:1px solid #777;padding:16px;white-space:pre-wrap} main{max-width:720px}button{margin:16px}</style><div id="root"></div><script type="module">' + script.replaceAll("</script", "<\\/script") + "</script>");
const browser = await chromium.launch({ headless: true, args: ["--mute-audio"] });
const context = await browser.newContext();
let store = openStore(":memory:");
let delaySave = false;
let releaseSave: (() => void) | undefined;
const results: { name: string; ok: boolean; detail?: unknown; error?: string }[] = [];
const assert = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
await context.exposeBinding("labStore", async (_source, method, input) => {
	if (method !== "save") throw new Error("unsupported");
	if (delaySave) await new Promise<void>(resolve => { releaseSave = resolve; });
	try {
		store.commit(input.baseRevision, input.text);
		return { status: "saved", snapshot: store.read() };
	} catch (error) {
		if (error instanceof Error && error.message === "revision_conflict")
			return { status: "conflict", snapshot: store.read() };
		throw error;
	}
});
const page = await context.newPage();
const errors: string[] = [];
page.on("pageerror", e => errors.push(e.message));
const url = new URL(`file://${buildDirectory}/lab.html`).href;
await page.goto(url);
await page.waitForFunction(() => !!(window as any).lab);
async function reset(text = "本文") {
	store.close(); store = openStore(":memory:"); store.create(text);
	await page.evaluate(snapshot => { (window as any).lab.clearDraft(); (window as any).lab.load(snapshot); (window as any).lab.setFailSave(false); }, store.read());
	await page.getByTestId("editor").click();
	await page.keyboard.press("ControlOrMeta+End");
}
const state = () => page.evaluate(() => (window as any).lab.state());
async function check(name: string, run: () => Promise<unknown>) {
	try { results.push({ name, ok: true, detail: await run() }); }
	catch (error) { results.push({ name, ok: false, error: error instanceof Error ? error.message : "unknown" }); }
	console.log(JSON.stringify(results.at(-1)));
}
try {
	await check("open-does-not-normalize-or-save-original", async () => {
		const text = "* first\r\n\r\n\r\nlast\r\n";
		await reset(text);
		const result = await page.evaluate(() => (window as any).lab.save());
		assert(result === "unchanged" && store.read()!.text === text && store.read()!.revision === 1, "opening rewrote original");
		return { revision: store.read()!.revision, byteExact: true };
	});
	const cdp = await context.newCDPSession(page);
	await check("chromium-native-ime-conversion-confirm-and-undo", async () => {
		await reset("前文 ");
		await cdp.send("Input.imeSetComposition", { text: "にほんご", selectionStart: 4, selectionEnd: 4 });
		assert((await state()).composing, "compositionstart missing");
		await cdp.send("Input.imeSetComposition", { text: "日本語", selectionStart: 3, selectionEnd: 3 });
		await cdp.send("Input.insertText", { text: "日本語" });
		await page.waitForFunction(() => !(window as any).lab.state().composing);
		const confirmed = await state();
		assert(confirmed.text.includes("日本語") && !confirmed.text.includes("にほんご"), "IME confirmation lost or duplicated");
		assert((confirmed.text.match(/日本語/g) ?? []).length === 1, "duplicate IME confirmation");
		await page.keyboard.press("ControlOrMeta+z");
		const undone = await state();
		assert(!undone.text.includes("日本語") && undone.text.includes("前文"), "IME undo damaged text");
		return { confirmed: confirmed.text, undone: undone.text, events: confirmed.events.slice(-12), osIme: false };
	});
	await check("chromium-native-ime-cancel", async () => {
		await reset("元の本文");
		await cdp.send("Input.imeSetComposition", { text: "へんかん", selectionStart: 4, selectionEnd: 4 });
		await cdp.send("Input.imeSetComposition", { text: "", selectionStart: 0, selectionEnd: 0 });
		const result = await state();
		assert(!result.text.includes("へんかん") && result.text.includes("元の本文"), "cancel left composition");
		return { text: result.text, composing: result.composing };
	});
	await check("imported-trailing-space-survives-following-ime-edit", async () => {
		await reset("前文 ");
		await cdp.send("Input.imeSetComposition", { text: "にほんご", selectionStart: 4, selectionEnd: 4 });
		await cdp.send("Input.insertText", { text: "日本語" });
		const text = (await state()).text;
		assert(text === "前文 日本語\n", `imported separator lost on edit: ${JSON.stringify(text)}`);
		return { text };
	});
	await check("remote-ai-result-during-ime-does-not-replace-composition", async () => {
		await reset("前文");
		await cdp.send("Input.imeSetComposition", { text: "にゅうりょく", selectionStart: 6, selectionEnd: 6 });
		const applied = await page.evaluate(() => (window as any).lab.remote({ revision: 2, text: "AIの結果" }));
		assert(applied === "blocked", "remote replaced IME");
		await cdp.send("Input.insertText", { text: "入力" });
		const result = await state();
		assert(result.text.includes("入力") && result.text.includes("前文") && !result.text.includes("AIの結果"), "composition lost");
		return { remote: applied, text: result.text };
	});
	await check("remote-ai-result-preserves-unsaved-user-input", async () => {
		await reset("原文");
		await page.keyboard.insertText("手入力");
		const before = await state();
		assert(before.dirty, "input not dirty");
		const applied = await page.evaluate(() => (window as any).lab.remote({ revision: 2, text: "AIの結果" }));
		assert(applied === "blocked" && (await state()).text === before.text, "unsaved text overwritten");
		return { remote: applied, text: before.text };
	});
	await check("remote-clean-document-and-stale-response", async () => {
		await reset("原文");
		assert(await page.evaluate(() => (window as any).lab.remote({ revision: 2, text: "新しい本文" })) === "applied", "clean remote not applied");
		assert(await page.evaluate(() => (window as any).lab.remote({ revision: 1, text: "古い本文" })) === "stale", "stale response adopted");
		assert((await state()).text === "新しい本文", "stale overwrote current");
		return { text: (await state()).text };
	});
	await check("backend-save-reload-and-unsaved-draft-recovery", async () => {
		await reset("元の本文");
		await page.keyboard.insertText("保存した編集");
		assert(await page.evaluate(() => (window as any).lab.save()) === "saved", "save failed");
		const saved = store.read()!;
		await page.reload(); await page.waitForFunction(() => !!(window as any).lab);
		await page.evaluate(snapshot => (window as any).lab.load(snapshot, true), saved);
		assert((await state()).text === saved.text && !(await state()).dirty, "saved reload mismatch");
		await page.getByTestId("editor").click(); await page.keyboard.press("ControlOrMeta+End"); await page.keyboard.insertText("未保存の追記");
		const unsaved = (await state()).text;
		await page.reload(); await page.waitForFunction(() => !!(window as any).lab);
		await page.evaluate(snapshot => (window as any).lab.load(snapshot, true), saved);
		assert((await state()).text === unsaved && (await state()).dirty, "draft lost on reload");
		return { savedRevision: saved.revision, draftRecovered: true };
	});
	await check("failed-save-retains-draft-and-saved-revision", async () => {
		await reset("保存済み");
		await page.keyboard.insertText("保存できない追記");
		const before = (await state()).text;
		await page.evaluate(() => (window as any).lab.setFailSave(true));
		assert(await page.evaluate(() => (window as any).lab.save()) === "save-failed", "failure reported success");
		assert((await state()).dirty && (await state()).text === before && store.read()!.revision === 1, "failure lost draft");
		return { dirty: true, savedRevision: 1 };
	});
	await check("typing-during-save-ack-retains-newer-draft", async () => {
		await reset("原文");
		await page.keyboard.insertText("保存対象");
		delaySave = true;
		const pending = page.evaluate(() => (window as any).lab.save());
		await page.waitForFunction(() => (window as any).lab.state().saving);
		await page.keyboard.insertText("さらに追記");
		const newerText = (await state()).text;
		delaySave = false; releaseSave!();
		assert(await pending === "saved-with-newer-draft", "save acknowledged newer draft as already saved");
		assert((await state()).dirty && (await state()).text === newerText, "newer draft lost");
		assert(!store.read()!.text.includes("さらに追記"), "test did not create in-flight edit");
		return { savedRevision: store.read()!.revision, newerDraftRetained: true };
	});
	await check("server-ai-commit-and-reload-cannot-rebase-old-user-draft-silently", async () => {
		await reset("原文\n\n後半\n");
		await page.keyboard.insertText("未保存の手入力");
		const userText = (await state()).text;
		assert(store.ai("doc.edit", { baseRevision: 1, edits: [{ old: "原文", new: "AI修正" }] }).ok, "AI setup failed");
		assert(await page.evaluate(snapshot => (window as any).lab.remote(snapshot), store.read()) === "blocked", "remote overwrote draft");
		assert(await page.evaluate(() => (window as any).lab.save()) === "conflict", "stale draft overwrote server");
		await page.reload(); await page.waitForFunction(() => !!(window as any).lab);
		await page.evaluate(snapshot => (window as any).lab.load(snapshot, true), store.read());
		assert((await state()).text === userText && (await state()).draftConflict, "recovery silently rebased stale draft");
		assert(await page.evaluate(() => (window as any).lab.save()) === "conflict", "recovered stale draft overwrote server");
		await page.getByTestId("editor").click(); await page.keyboard.press("ControlOrMeta+End"); await page.keyboard.insertText("競合後の追記");
		await page.reload(); await page.waitForFunction(() => !!(window as any).lab);
		await page.evaluate(snapshot => (window as any).lab.load(snapshot, true), store.read());
		assert((await state()).text.includes("競合後の追記") && (await state()).draftConflict, "editing a conflicted draft silently changed its base revision");
		assert(store.read()!.text.includes("AI修正") && store.read()!.revision === 2, "AI revision lost");
		return { savedRevision: 2, draftRecovered: true, conflictRetainedAfterReload: true };
	});
	await check("full-toolbar-markdown-format-retention", async () => {
		await reset("文字装飾");
		await page.evaluate(() => (window as any).lab.format());
		const text = (await state()).rendered;
		// Keep the requirement: reporting missing features is an adoption failure, not an allowed normalization.
		assert(text.includes("#ff0000") && text.includes("24px") && text.includes("center"), `color/fontSize/alignment not retained: ${text}`);
		return { text };
	});
	await page.screenshot({ path: `${buildDirectory}/lab-browser.png` });
} finally {
	await writeFile(`${out}/browser.json`, JSON.stringify({ results, pageErrors: errors, chromium: browser.version(), transport: "Playwright exposed test port; no HTTP server", ai: "fixed results using common document tools", osIme: "not tested" }, null, 2) + "\n");
	store.close(); await browser.close();
}
if (results.some(r => !r.ok) || errors.length) process.exitCode = 1;
