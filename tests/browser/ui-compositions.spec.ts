import { expect, test, type Locator, type Page } from "@playwright/test";
import { closeArtifact, openFromLauncher } from "./artifact-launcher";
import { createFixture } from "./fixture";

/**
 * UI自由制作: a specialist session builds the screen in a preview-first studio.
 *
 * Fixture contract (scripts/ui-compositions-fixture-server.ts, wired by the integrator): a
 * harness with the ui-compositions bundle and scripted models where
 * - the normal addressee answers a message containing `requests.create` by starting the session
 *   toolchain (`ui_create`) with that text;
 * - the specialist answers by the order of the session's messages:
 *   1. `requests.create`: `doc.write` with title "来場者アンケート" and the survey layout
 *      below (text-block 見出し + form "満足度" radio 満足/普通/不満 + text "感想"), then replies
 *      "アンケートの初稿を作りました。";
 *   2. `requests.soften`: `doc.edit` (title "やわらかいアンケート", the layout gets
 *      `gap: "relaxed"`; `doc.write` when the text lacks the expected lines), then
 *      replies "雰囲気をやわらかくしました。";
 *   3. `requests.explain`: replies "このままで問題ありません。" without applying anything;
 *   4. `requests.again`: `doc.write` with title "再編集したアンケート", then replies.
 */
const requests = {
	create: "来場者アンケートのUIを作ってください",
	soften: "もっとやわらかい雰囲気にしてください",
	explain: "この画面の使い方を教えてください",
	again: "見出しを少し直してください",
};

test.setTimeout(90000);
const fixture = createFixture();
let origin: string;
test.beforeAll(async () => {
	const [apiPort, webPort] = (await fixture.ports(2)) as [number, number];
	origin = `http://127.0.0.1:${webPort}`;
	await fixture.launch(
		["scripts/ui-compositions-fixture-server.ts"],
		{ EUMENES_PORT: String(apiPort), EUMENES_ORIGIN: origin },
		{ ports: [apiPort] },
	);
	await fixture.ready(`http://127.0.0.1:${apiPort}/api/status`);
	await fixture.launchWeb({
		webPort,
		apiPort,
		token: "fixture-token-for-toolchain-browser",
		cacheDir: `/tmp/eumenes-ui-vite-${webPort}`,
	});
	await fixture.ready(origin);
});
test.afterAll(() => fixture.stopAll());

async function say(page: Page, text: string) {
	// The conversation's own send button; a saved work's form has a 送信 button too.
	const conversation = page.getByRole("region", { name: "会話" });
	await conversation.getByRole("textbox", { name: "メッセージ" }).fill(text);
	await conversation.getByRole("button", { name: "送信", exact: true }).click();
}
const studioOf = (page: Page) => page.locator(".aui-ui-studio");
const button = (studio: Locator, name: string) =>
	studio.getByRole("button", { name, exact: true });
const addressee = (page: Page) => page.locator(".conversation-addressee");

/** Starts a session with the first request and waits for the draft. */
async function startSession(page: Page) {
	await page.goto(origin);
	await expect(addressee(page)).toContainText("通常");
	await say(page, requests.create);
	const studio = studioOf(page);
	await expect(studio).toBeVisible();
	await expect(
		studio.getByRole("heading", { name: "来場者アンケート", level: 2 }).first(),
	).toBeVisible();
	return studio;
}

test("a request switches to the specialist and the draft fills the studio", async ({
	page,
}) => {
	await page.goto(origin);
	await say(page, requests.create);
	await expect(page.locator(".conversation-notice")).toContainText(
		"サブエージェントに切り替えます",
	);
	await expect(addressee(page)).toContainText("UI自由制作");
	const studio = studioOf(page);
	await expect(studio).toBeVisible();
	// The draft is the main content, rendered with its real controls.
	const preview = studio.getByRole("region").filter({ hasText: "プレビュー" });
	await expect(preview.getByRole("radio", { name: "満足" })).toBeVisible();
	await expect(preview.getByRole("textbox", { name: "感想" })).toBeVisible();
	await expect(studio.getByText("編集中・未保存")).toBeVisible();
	await expect(
		studio.getByText("保存ボタンを押すまで作品には保存されません"),
	).toBeVisible();
	// Nothing of the old one-shot flow remains.
	await expect(page.getByRole("tab", { name: "作る" })).toHaveCount(0);
	await expect(page.getByText("制作条件")).toHaveCount(0);
	// The trial form records nothing.
	await preview.getByRole("radio", { name: "満足" }).check();
	await preview.getByRole("button", { name: "送信（試用）" }).click();
	await expect(
		preview.getByText("試用です。回答は保存されません。"),
	).toBeVisible();
	// Messages keep going to the specialist, which may answer without changing the draft.
	await say(page, requests.explain);
	// The reply is also announced through a visually hidden live region; check the shown one.
	await expect(
		page.getByText("このままで問題ありません。", { exact: true }),
	).toBeVisible();
	await expect(
		studio.getByRole("heading", { name: "来場者アンケート", level: 2 }).first(),
	).toBeVisible();
	await expect(addressee(page)).toContainText("UI自由制作");
});

test("undo, redo and the device switch work on the same draft", async ({
	page,
}) => {
	const studio = await startSession(page);
	await expect(button(studio, "元に戻す")).toBeEnabled();
	await say(page, requests.soften);
	await expect(
		studio
			.getByRole("heading", { name: "やわらかいアンケート", level: 2 })
			.first(),
	).toBeVisible();
	// Display state: typed trial input survives the switch and an update.
	const comment = studio.getByRole("textbox", { name: "感想" });
	await comment.fill("試し入力");
	await studio.getByRole("button", { name: /モバイル/ }).click();
	await expect(studio.locator(".aui-ui-preview-mobile")).toBeVisible();
	await expect(comment).toHaveValue("試し入力");
	await button(studio, "元に戻す").click();
	await expect(
		studio.getByRole("heading", { name: "来場者アンケート", level: 2 }).first(),
	).toBeVisible();
	await expect(studio.locator(".aui-ui-preview-mobile")).toBeVisible();
	await button(studio, "やり直す").click();
	await expect(
		studio
			.getByRole("heading", { name: "やわらかいアンケート", level: 2 })
			.first(),
	).toBeVisible();
	await studio.getByRole("button", { name: /デスクトップ/ }).click();
	await expect(studio.locator(".aui-ui-preview-desktop")).toBeVisible();
	await expect(comment).toHaveValue("試し入力");
});

test("the source view shows the shown definition as JSON and keeps the display state", async ({
	page,
}) => {
	const studio = await startSession(page);
	const comment = studio.getByRole("textbox", { name: "感想" });
	await comment.fill("試し入力");
	await studio.getByRole("button", { name: "ソース", exact: true }).click();
	const source = studio.getByRole("region", { name: "OpenUI設定JSON" });
	await expect(source).toBeVisible();
	await expect(source).toContainText('"view": "layout"');
	await expect(studio.getByText("編集中", { exact: true })).toBeVisible();
	// Read-only, with numbered lines in a gutter that is not part of the text.
	await expect(source.getByRole("textbox")).toHaveCount(0);
	await expect(studio.locator(".aui-ui-source-gutter")).toHaveAttribute(
		"aria-hidden",
		"true",
	);
	// The device switch belongs to the preview only.
	await expect(studio.getByRole("button", { name: /モバイル/ })).toHaveCount(0);
	// A new draft keeps the source mode and replaces the text.
	await say(page, requests.soften);
	await expect(source).toContainText('"gap": "relaxed"');
	await studio.getByRole("button", { name: "プレビュー", exact: true }).click();
	await expect(comment).toHaveValue("試し入力");
	// There is no separate JSON screen any more.
	await expect(studio.getByText("OpenUI設定JSONを確認")).toHaveCount(0);
	await expect(page.locator(".aui-json-view")).toHaveCount(0);
});

test("a restored saved work can be left with New creation", async ({
	page,
}) => {
	const studio = await startSession(page);
	await button(studio, "保存").click();
	await button(studio, "破棄").click();
	await expect(addressee(page)).toContainText("通常");
	await studio.getByRole("button", { name: "作品履歴" }).click();
	await page
		.getByRole("group", { name: "保存した作品" })
		.getByRole("button", { name: "来場者アンケート" })
		.click();
	await expect(studio.getByText("保存済み", { exact: true })).toBeVisible();
	await studio.getByRole("button", { name: "新規作成" }).click();
	await expect(studio.getByText("ここに作品を表示します")).toBeVisible();
	await expect(
		studio.getByText("会話で作りたいUIを伝えてください"),
	).toBeVisible();
	await expect(studio.getByText("保存済み", { exact: true })).toHaveCount(0);
	// The history no longer marks the old work, and the next message names no viewed work.
	await studio.getByRole("button", { name: "作品履歴" }).click();
	await expect(
		page
			.getByRole("group", { name: "保存した作品" })
			.getByRole("button", { name: "来場者アンケート" }),
	).not.toHaveAttribute("aria-current", "true");
});

test("saving makes a work; history shows it and its form takes real answers", async ({
	page,
}) => {
	const studio = await startSession(page);
	await expect(button(studio, "保存")).toBeEnabled();
	await button(studio, "保存").click();
	await expect(studio.getByText("編集中", { exact: true })).toBeVisible();
	await expect(button(studio, "保存")).toBeDisabled();
	await closeArtifact(page, "UI自由制作");
	await expect(addressee(page)).toContainText("通常");
	await expect(studioOf(page)).toHaveCount(0);

	await openFromLauncher(page, "UI自由制作");
	const reopened = studioOf(page);
	await reopened.getByRole("button", { name: "作品履歴" }).click();
	// The file's tests share one backend, so earlier tests may have saved the same title; the
	// history lists the newest first, which is the work saved above.
	await page
		.getByRole("group", { name: "保存した作品" })
		.getByRole("button", { name: "来場者アンケート" })
		.first()
		.click();
	await expect(reopened.getByText("保存済み", { exact: true })).toBeVisible();
	await expect(button(reopened, "保存")).toBeDisabled();
	await reopened.getByRole("radio", { name: "満足" }).check();
	// A saved work's form submits for real; its button is labelled 送信 (the draft's trial says 送信（試用）).
	await reopened
		.getByLabel("組合せ表示")
		.getByRole("button", { name: "送信", exact: true })
		.click();
	await expect(reopened.getByText("送信しました")).toBeVisible();
	// The viewed work travels with the next message, so the specialist edits that work.
	await say(page, requests.again);
	await expect(addressee(page)).toContainText("UI自由制作");
	await expect(
		reopened
			.getByRole("heading", { name: "再編集したアンケート", level: 2 })
			.first(),
	).toBeVisible();
});

test("closing unsaved work asks first; discard needs no confirmation", async ({
	page,
}) => {
	const studio = await startSession(page);
	// Refresh is beside the view switch; closing is the tab's job.
	await expect(studio.getByRole("button", { name: "その他" })).toHaveCount(0);
	await expect(page.getByRole("button", { name: "表示を更新" })).toBeVisible();
	await expect(
		page.getByRole("button", { name: "制作画面を閉じる" }),
	).toHaveCount(0);
	await page.getByRole("button", { name: "UI自由制作を閉じる" }).click();
	const dialog = page.getByRole("dialog");
	await expect(dialog).toContainText("未保存");
	await dialog.getByRole("button", { name: "編集を続ける" }).click();
	await expect(studio).toBeVisible();
	await expect(addressee(page)).toContainText("UI自由制作");
	// Return keeps the unsaved draft suspended and says so.
	await button(studio, "会話に戻る").click();
	await expect(addressee(page)).toContainText("通常");
	await expect(studio.getByText(/未保存・一時保留/).first()).toBeVisible();
	await studio.getByRole("button", { name: "編集を再開" }).click();
	await expect(addressee(page)).toContainText("UI自由制作");
	// Discard is always there and asks nothing.
	await button(studio, "破棄").click();
	await expect(dialog).toHaveCount(0);
	await expect(addressee(page)).toContainText("通常");
	await expect(studio.getByText("ここに作品を表示します")).toBeVisible();
});

test("the studio keeps working at a narrow width and in the dark theme", async ({
	page,
}) => {
	const studio = await startSession(page);
	await page.setViewportSize({ width: 390, height: 844 });
	await expect(studio).toBeVisible();
	const overflowing = await studio.evaluate(
		(element) => element.scrollWidth > element.clientWidth,
	);
	expect(overflowing).toBe(false);
	for (const name of ["保存", "破棄", "元に戻す"])
		await expect(button(studio, name)).toBeVisible();
	await expect(studio.getByRole("button", { name: /モバイル/ })).toBeVisible();
	const colors = () =>
		studio.evaluate((element) => {
			const body = element.closest(".artifact-panel-body") as HTMLElement;
			return {
				background: getComputedStyle(element).color,
				outerPadding: parseFloat(getComputedStyle(body).paddingLeft),
			};
		});
	const light = await colors();
	await page.evaluate(() => {
		document.documentElement.dataset.theme = "dark";
	});
	const dark = await colors();
	expect(dark.background).not.toBe(light.background);
	expect(dark.outerPadding).toBeGreaterThanOrEqual(8);
});
