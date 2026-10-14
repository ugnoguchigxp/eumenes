import { expect, test, type Page } from "@playwright/test";
import { openFromLauncher } from "./artifact-launcher";
import { createFixture } from "./fixture";

/*
 * The task board over a fake `claude` (tests/browser/fixtures/fake-claude.sh) on real PTYs: the
 * fake sends the same hooks as Claude Code, so runs are tracked as in production. No real Claude,
 * no LARM. Markers in a prompt shape the fake's turn: [slow] 8 s, [long] 30 s, [perm] asks for permission
 * first, [edit:path] reports a file change.
 */
test.describe.configure({ mode: "serial" });
test.setTimeout(120000);
const fixture = createFixture();
const token = "fixture-token-for-toolchain-browser";
let origin: string;
let api: string;
test.beforeAll(async () => {
	const [apiPort, webPort] = (await fixture.ports(2)) as [number, number];
	origin = `http://127.0.0.1:${webPort}`;
	api = `http://127.0.0.1:${apiPort}`;
	await fixture.launch(
		["scripts/kanban-fixture-server.ts"],
		{ EUMENES_PORT: String(apiPort), EUMENES_ORIGIN: origin },
		{ ports: [apiPort] },
	);
	await fixture.ready(`${api}/api/status`);
	await fixture.launchWeb({
		webPort,
		apiPort,
		token,
		cacheDir: `/tmp/eumenes-kanban-vite-${webPort}`,
	});
	await fixture.ready(origin);
});
test.afterAll(() => fixture.stopAll());

const evidence = "spec/verification/kanban-board-2026-10-14";
const get = async (path: string) =>
	(
		await fetch(`${api}${path}`, {
			headers: { authorization: `Bearer ${token}` },
		})
	).json();

const board = (page: Page) =>
	page.getByRole("region", { name: "タスクボード" });
const card = (page: Page, title: string) =>
	board(page)
		.locator("article.kanban-card")
		.filter({ has: page.getByRole("heading", { name: title, exact: true }) });
const button = (page: Page, title: string, name: string) =>
	card(page, title).getByRole("button", { name, exact: true });

/**
 * New-notification cards float over the top right of the board. They stay visible (screenshots
 * show them) but must not take the clicks of the board under them.
 */
const letClicksThrough = (page: Page) =>
	page.addStyleTag({
		content:
			".timer-notifications, .timer-notifications * { pointer-events: none !important; }",
	});
async function openBoard(page: Page) {
	await page.setViewportSize({ width: 1500, height: 950 });
	await page.goto(origin);
	await letClicksThrough(page);
	await openFromLauncher(page, "タスクボード");
	await expect(board(page)).toBeVisible();
}
async function addTask(page: Page, title: string, prompt: string) {
	await board(page).getByRole("button", { name: "タスクを追加" }).click();
	await page.getByRole("textbox", { name: "タイトル" }).fill(title);
	await page.getByRole("textbox", { name: "依頼内容" }).fill(prompt);
	await page.getByRole("button", { name: "追加", exact: true }).click();
	await expect(card(page, title)).toBeVisible();
}
const label = (page: Page, title: string) =>
	card(page, title).locator(".kanban-label");
const status = (page: Page, title: string) =>
	card(page, title).locator(".kanban-status");

test("register, run, queue, work, Done, follow-up, then commit & push after the confirmation", async ({
	page,
}) => {
	await openBoard(page);
	await addTask(
		page,
		"README の手順修正",
		"README の手順を直して [perm] [edit:docs/readme.md]",
	);
	await addTask(page, "テスト修正", "テストを直して [slow]");
	await expect(card(page, "README の手順修正")).toHaveAttribute(
		"data-column",
		"todo",
	);
	await page.screenshot({ path: `${evidence}/e2e-registered.png` });

	// Two runs at once: the first is handed over, the second waits its turn.
	await button(page, "README の手順修正", "実行").click();
	await expect(status(page, "README の手順修正")).toBeVisible();
	await button(page, "テスト修正", "実行").click();
	await expect(status(page, "テスト修正")).toHaveText("キュー待ち（1番目）");
	await expect(status(page, "README の手順修正")).toHaveText(
		"許可を待っています",
	);
	await expect(board(page).getByLabel("実行キュー")).toContainText("待機中");
	await page.screenshot({ path: `${evidence}/e2e-queued-and-waiting.png` });

	// The first finishes (Done); only then is the second handed over and works.
	await expect(label(page, "README の手順修正")).toHaveText("Done", {
		timeout: 30000,
	});
	await expect(status(page, "テスト修正")).toHaveText("作業中", {
		timeout: 20000,
	});
	await expect(
		card(page, "README の手順修正").getByText(
			"このタスクの後に別のタスクが実行されています",
		),
	).toBeVisible();
	await page.screenshot({
		path: `${evidence}/e2e-first-done-second-working.png`,
	});
	await expect(label(page, "テスト修正")).toHaveText("Done", {
		timeout: 30000,
	});

	// The report and the changed files are on the card.
	await button(page, "README の手順修正", "詳細を見る").click();
	const detail = card(page, "README の手順修正");
	await expect(detail.getByLabel("最後の報告")).toContainText(
		"README のセットアップ手順を更新しました",
	);
	await expect(detail.getByLabel("変更したファイル")).toContainText(
		"docs/readme.md",
	);

	// A follow-up goes to the same conversation and ends in Done again with both files.
	await button(page, "README の手順修正", "追加で直す").click();
	await page
		.getByRole("textbox", { name: "追加の依頼" })
		.fill("説明をもう少し丁寧に [edit:docs/extra.md]");
	await page.getByRole("button", { name: "送る" }).click();
	await expect(status(page, "README の手順修正")).toBeVisible();
	await expect(label(page, "README の手順修正")).toHaveText("Done", {
		timeout: 30000,
	});
	await button(page, "README の手順修正", "詳細を見る").click();
	await expect(
		card(page, "README の手順修正").getByLabel("変更したファイル"),
	).toContainText("docs/extra.md");
	await expect(
		card(page, "README の手順修正").getByLabel("変更したファイル"),
	).toContainText("docs/readme.md");

	// Commit & push needs the person's confirmation, which shows the files and the report.
	await button(page, "README の手順修正", "commit & push").click();
	const dialog = page.getByRole("dialog", { name: "commit & push の確認" });
	await expect(dialog).toBeVisible();
	await expect(dialog).toContainText("docs/readme.md");
	await expect(dialog).toContainText("docs/extra.md");
	await expect(dialog).toContainText("最後の報告");
	await page.screenshot({ path: `${evidence}/e2e-commit-push-dialog.png` });
	await dialog
		.getByRole("button", { name: "commit & push を依頼する" })
		.click();
	await expect(
		card(page, "README の手順修正").getByText("commit & push の報告あり"),
	).toBeVisible({
		timeout: 30000,
	});
	await button(page, "README の手順修正", "詳細を見る").click();
	await expect(
		card(page, "README の手順修正").getByLabel("最後の報告"),
	).toContainText("commit して push しました");
	await page.screenshot({ path: `${evidence}/e2e-commit-push-reported.png` });

	// Notifications: one per Done, permission wait and commit & push; moves and edits are silent.
	// The follow-up repeats the first request as a summary, so the fake asks for permission again.
	const { notices, unread } = await get("/api/kanban/notices");
	expect(notices.map((n: { text: string }) => n.text).reverse()).toEqual([
		"タスク『README の手順修正』が許可を待っています",
		"タスク『README の手順修正』が終わりました",
		"タスク『テスト修正』が終わりました",
		"タスク『README の手順修正』が許可を待っています",
		"タスク『README の手順修正』が終わりました",
		"タスク『README の手順修正』の commit & push の報告があります",
	]);
	expect(unread).toBe(6);
	const read = await fetch(`${api}/api/kanban/notices/${notices[0].id}/read`, {
		method: "POST",
		headers: { authorization: `Bearer ${token}` },
	});
	expect(read.status).toBe(204);
	expect((await get("/api/kanban/notices")).unread).toBe(5);

	// The board survives a reload.
	await page.reload();
	await letClicksThrough(page);
	await openFromLauncher(page, "タスクボード");
	await expect(label(page, "README の手順修正")).toHaveText("Done");
	await expect(
		card(page, "README の手順修正").getByText("commit & push の報告あり"),
	).toBeVisible();
	await expect(label(page, "テスト修正")).toHaveText("Done");
});

test("five tasks run one after another, one process at a time, each in its own conversation", async ({
	page,
}) => {
	await openBoard(page);
	const titles = ["連続1", "連続2", "連続3", "連続4", "連続5"];
	// The first one is slow so that the others are still waiting when they are all started.
	for (const title of titles)
		await addTask(
			page,
			title,
			`${title} をやって${title === "連続1" ? " [slow]" : ""}`,
		);
	for (const title of titles) await button(page, title, "実行").click();
	await expect(status(page, "連続5")).toHaveText(/^キュー待ち（[1-4]番目）$/);
	await page.screenshot({ path: `${evidence}/e2e-five-queued.png` });
	let working = 0;
	for (let i = 0; i < 80 && (await label(page, "連続5").count()) === 0; i++) {
		working = Math.max(
			working,
			await board(page)
				.locator(".kanban-status", { hasText: "作業中" })
				.count(),
		);
		await page.waitForTimeout(250);
	}
	// Never two at once.
	expect(working).toBeLessThanOrEqual(1);
	for (const title of titles)
		await expect(label(page, title)).toHaveText("Done", { timeout: 30000 });
	await page.screenshot({ path: `${evidence}/e2e-five-done.png` });
	const sessions = (await get("/api/terminals")).sessions as Array<{
		owner: string;
		status: string;
	}>;
	const kanban = sessions.filter((s) => s.owner.startsWith("kanban:"));
	// One conversation (and PTY) per task; idle ones were closed to stay within the limit.
	expect(kanban.length).toBeGreaterThanOrEqual(5);
	expect(
		kanban.filter((s) => s.status === "running").length,
	).toBeLessThanOrEqual(4);
});

test("cancel a waiting task and stop a working one; the next task goes on", async ({
	page,
}) => {
	await openBoard(page);
	await addTask(page, "長い作業", "長い作業をやって [long]");
	await addTask(page, "取り消す作業", "取り消される作業");
	await addTask(page, "あとの作業", "あとの作業をやって");
	await button(page, "長い作業", "実行").click();
	await expect(status(page, "長い作業")).toHaveText("作業中", {
		timeout: 20000,
	});
	await button(page, "取り消す作業", "実行").click();
	await button(page, "あとの作業", "実行").click();
	await expect(status(page, "あとの作業")).toHaveText("キュー待ち（2番目）");

	// A waiting run is cancelled before anything is sent.
	await button(page, "取り消す作業", "取消").click();
	await expect(label(page, "取り消す作業")).toHaveText("Blocker");
	await expect(card(page, "取り消す作業")).toContainText(
		"送る前に取り消しました",
	);
	await expect(status(page, "あとの作業")).toHaveText("キュー待ち（1番目）");

	// The working one is stopped; the next starts only once the process is gone.
	await page.screenshot({ path: `${evidence}/e2e-before-stop.png` });
	await button(page, "長い作業", "止めて Blocker にする").click();
	await expect(label(page, "長い作業")).toHaveText("Blocker", {
		timeout: 20000,
	});
	await expect(card(page, "長い作業")).toContainText("利用者が止めました");
	await expect(label(page, "あとの作業")).toHaveText("Done", {
		timeout: 30000,
	});
	await page.screenshot({ path: `${evidence}/e2e-stopped-and-cancelled.png` });
	await expect(board(page).getByLabel("実行キュー")).not.toContainText(
		"停止中",
	);

	// A Blocker can be run again, and a Done card can go back to todo.
	await button(page, "長い作業", "未着手へ戻す").click();
	await expect(card(page, "長い作業")).toHaveAttribute("data-column", "todo");
	await button(page, "あとの作業", "未着手へ戻す").click();
	await expect(card(page, "あとの作業")).toHaveAttribute("data-column", "todo");
});

test("a stale screen shows the conflict message and nothing changes", async ({
	browser,
}) => {
	const first = await browser.newPage();
	const second = await browser.newPage();
	await openBoard(first);
	await addTask(first, "競合する作業", "競合の確認");
	await openBoard(second);
	await expect(card(second, "競合する作業")).toBeVisible();
	// The second screen stops hearing about changes, then the first one edits the card.
	await second.route("**/sources/kanban**", (route) => route.abort());
	await button(first, "競合する作業", "編集").click();
	await first.getByRole("textbox", { name: "タイトル" }).fill("競合した作業");
	await first.getByRole("button", { name: "保存" }).click();
	await expect(card(first, "競合した作業")).toBeVisible();
	await button(second, "競合する作業", "編集").click();
	await second
		.getByRole("textbox", { name: "タイトル" })
		.fill("古い画面からの編集");
	await second.getByRole("button", { name: "保存" }).click();
	await expect(second.getByRole("alert")).toContainText(
		"他の操作でタスクの状態が変わりました",
	);
	await second.screenshot({ path: `${evidence}/e2e-conflict.png` });
	await second.unroute("**/sources/kanban**");
	await second.reload();
	await letClicksThrough(second);
	await openFromLauncher(second, "タスクボード");
	await expect(card(second, "競合した作業")).toBeVisible();
	await expect(card(second, "古い画面からの編集")).toHaveCount(0);
	await first.close();
	await second.close();
});
