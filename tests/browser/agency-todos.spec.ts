import bundle from "../../api/domains/capabilities/bundles/agency-todos-screen.bundle.json" with { type: "json" };
import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

// Build and fulfill resources in the browser: no fixture or application server is started.
let build: string;
test.beforeAll(() => {
	build = mkdtempSync(join(tmpdir(), "eumenes-todo-browser-"));
	execFileSync(
		"bun",
		[
			"build",
			"tests/browser/fixtures/agency-todos.tsx",
			"--target=browser",
			"--format=iife",
			"--minify",
			`--outdir=${build}`,
		],
		{ cwd: resolve("."), stdio: "pipe" },
	);
});
test.afterAll(() => rmSync(build, { recursive: true, force: true }));

test("TODO artifact renders and pages in desktop and narrow layouts", async ({
	page,
}) => {
	const errors: string[] = [];
	let empty = false;
	page.on("pageerror", (error) => errors.push(error.message));
	const baseTime = Date.UTC(2026, 9, 23, 22, 10);
	const requests = [
		"調査結果をまとめて、比較表を作成する",
		"プレゼン資料を作成する",
		"夜のドライブ向けの曲を作る",
		"週末の予定を調べる",
		"画像のデザイン案を作成する",
		"実装内容を確認して結果をまとめる",
	];
	await page.route("http://127.0.0.1:4444/**", (route) => {
		const url = new URL(route.request().url());
		if (url.pathname.endsWith("/sources/agency-todos")) {
			const { state, pageIndex, pageSize } = JSON.parse(
				url.searchParams.get("params")!,
			);
			const counts = empty
				? { todo: 0, done: 0, archived: 0 }
				: { todo: 12, done: 3, archived: 28 };
			const total =
				state === "active" ? counts.todo + counts.done : counts.archived;
			const rows = Array.from(
				{ length: Math.min(pageSize, total - pageIndex * pageSize) },
				(_, n) => {
					const index = pageIndex * pageSize + n;
					const rowState =
						state === "archived"
							? "archived"
							: index % 5 === 1
								? "done"
								: "todo";
					return {
						id: `work-${index}`,
						state: rowState,
						request: `${requests[index % requests.length]} (${index + 1})`,
						status:
							rowState === "todo"
								? index === 2
									? "waiting_user"
									: "deciding"
								: "completed",
						pipeline: index % 3 === 1,
						resultSummary:
							rowState === "todo"
								? null
								: "作成と確認が完了しました。結果は会話にまとめています。",
						heldEventId: rowState === "done" ? `event-${index}` : null,
						createdAt: baseTime - index * 60000,
						updatedAt: baseTime + 60000,
						releasedAt: rowState === "archived" ? baseTime + 120000 : null,
					};
				},
			);
			return route.fulfill({
				json: {
					revision: 200,
					data: { state, pageIndex, pageSize, rows, total, counts },
				},
			});
		}
		if (url.pathname === "/api/toolchain-artifacts")
			return route.fulfill({
				json: {
					artifacts: [
						{
							artifactRevisionId: "artifact:agency.todos@1",
							title: "TODOリスト",
							adapterRefs: ["adapter:task-execution@1"],
							launcher: bundle.artifacts[0]!.launcher,
						},
					],
				},
			});
		if (url.pathname.startsWith("/api/toolchain-artifacts/"))
			return route.fulfill({
				json: {
					artifact: bundle.artifacts[0],
					artifactRevisionId: "artifact:agency.todos@1",
					digest: "fixture",
					scopeRef: "scope:fixture",
				},
			});
		return route.fulfill({
			contentType: "text/html",
			body: '<!doctype html><html lang="ja" data-theme="dark"><meta charset="utf-8"><div id="root"></div></html>',
		});
	});
	await page.setViewportSize({ width: 1200, height: 870 });
	await page.goto("http://127.0.0.1:4444/");
	await page.addStyleTag({
		content: readFileSync(
			"packages/design-system/dist/design-system.css",
			"utf8",
		),
	});
	await page.addStyleTag({
		content:
			"body{margin:0;background:var(--background);color:var(--foreground);font-family:system-ui,sans-serif}.workspace-layout{display:grid;height:100dvh;min-height:0}.chat-panel{display:flex;flex-direction:column;min-width:0;min-height:0;padding:24px;gap:16px;background:var(--card)}.fixture-composer{margin-top:auto;padding:16px;border:1px solid var(--border);border-radius:var(--radius);color:var(--muted-foreground)}.artifact-panel{display:grid;grid-template-rows:auto minmax(0,1fr);min-width:0;min-height:0}.artifact-panel-header{border-bottom:1px solid var(--border)}.artifact-panel-body{padding:8px;min-width:0;overflow:auto}*{box-sizing:border-box}",
	});
	await page.addStyleTag({ path: join(build, "agency-todos.css") });
	await page.addScriptTag({ path: join(build, "agency-todos.js") });
	await expect(
		page.getByRole("tab", { name: "todo・done", exact: true }),
	).toBeVisible();
	await expect(page.getByRole("table")).toHaveCount(1);
	await expect(
		page
			.getByRole("table", { name: "todo・done", exact: true })
			.getByRole("row"),
	).toHaveCount(11);
	await expect(
		page.getByRole("table").getByText("todo", { exact: true }).first(),
	).toBeVisible();
	await expect(
		page.getByRole("table").getByText("done", { exact: true }).first(),
	).toBeVisible();
	await expect(page.getByRole("combobox")).toHaveCount(1);
	await expect(
		page.getByRole("region", { name: "会話", exact: true }),
	).toBeVisible();
	const panelWidth = await page
		.locator(".artifact-panel")
		.evaluate((el) => el.getBoundingClientRect().width);
	expect(panelWidth).toBeLessThan(650);
	expect(panelWidth).toBeGreaterThan(500);
	const out = resolve("spec/design/todo-artifact-2026-10-24");
	mkdirSync(out, { recursive: true });
	await page.screenshot({
		path: join(out, "implemented-desktop-v4.png"),
		fullPage: true,
	});
	await page.getByRole("button", { name: "todo・doneの次のページ" }).click();
	await expect(page.getByRole("table").getByRole("row")).toHaveCount(6);
	await expect(page.getByText("15件 · 2 / 2ページ")).toBeVisible();
	await expect(
		page.getByRole("button", { name: "todo・doneの次のページ" }),
	).toBeDisabled();
	await expect(page.getByRole("table")).toHaveCount(1);
	await page.getByRole("tab", { name: "archived", exact: true }).click();
	await expect(page.getByRole("columnheader")).toHaveText(["依頼内容", "状態"]);
	await expect(page.getByRole("button", { name: /詳細/ })).toHaveCount(0);
	await expect(page.locator("time")).toHaveCount(0);
	await page.getByRole("button", { name: "報告済みの次のページ" }).click();
	await expect(page.getByText("28件 · 2 / 3ページ")).toBeVisible();
	await page
		.getByRole("combobox", { name: "報告済みの表示件数" })
		.selectOption("25");
	await expect(page.getByText("28件 · 1 / 2ページ")).toBeVisible();
	await page.setViewportSize({ width: 390, height: 844 });
	await page.screenshot({
		path: join(out, "implemented-narrow-v4.png"),
		fullPage: true,
	});
	expect(
		await page.evaluate(
			() => document.documentElement.scrollWidth <= window.innerWidth,
		),
	).toBe(true);
	const table = page.getByRole("region", { name: "報告済みの表", exact: true });
	expect(await table.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
		true,
	);
	await expect(page.getByRole("dialog")).toHaveCount(0);
	empty = true;
	await page.setViewportSize({ width: 1200, height: 870 });
	await page.getByRole("button", { name: "更新", exact: true }).click();
	await expect(page.getByText("報告済みの仕事はありません。")).toBeVisible();
	await expect(
		page.getByRole("button", { name: "報告済みの次のページ" }),
	).toBeDisabled();
	await page.screenshot({
		path: join(out, "implemented-empty-v4.png"),
		fullPage: true,
	});
	await page.evaluate(() => {
		document.documentElement.dataset.theme = "light";
	});
	await expect(page.getByRole("table")).toBeVisible();
	expect(errors).toEqual([]);
});
