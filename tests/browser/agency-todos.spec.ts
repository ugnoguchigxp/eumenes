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
	const reads: Array<{ state: string; pageIndex: number; pageSize: number }> =
		[];
	const actions: Array<Record<string, unknown>> = [];
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
			reads.push({ state, pageIndex, pageSize });
			const counts = empty
				? { todo: 0, archived: 0 }
				: { todo: 15, archived: 28 };
			const total = state === "active" ? counts.todo : counts.archived;
			const rows = Array.from(
				{ length: Math.min(pageSize, total - pageIndex * pageSize) },
				(_, n) => {
					const index = pageIndex * pageSize + n;
					const rowState = state === "archived" ? "archived" : "todo";
					// The current source contract (todoPageSchema): open work is todo/waiting, the archive is done.
					return {
						id: `work-${index}`,
						request: `${requests[index % requests.length]} (${index + 1})`,
						status:
							rowState === "todo" ? (index === 2 ? "waiting" : "todo") : "done",
						outcome: rowState === "todo" ? null : "succeeded",
						summary:
							rowState === "todo"
								? index === 2
									? "どちらの案にしますか"
									: null
								: "作成と確認が完了しました。結果は会話にまとめています。",
						pipeline: index % 3 === 1,
						archived: rowState === "archived",
						updatedAt: new Date(baseTime + 60000).toISOString(),
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
		if (
			url.pathname === "/api/toolchain-actions" &&
			route.request().method() === "POST"
		) {
			const event = route.request().postDataJSON() as Record<string, unknown>;
			actions.push(event);
			return route.fulfill({
				json: {
					eventId: event.eventId,
					status: "accepted",
					createdAt: new Date(baseTime).toISOString(),
					result: {
						version: 1,
						executionId: "archive-1",
						artifactRevisionId: "artifact:agency.todos@4",
						outcome: "completed",
						resultRefs: [],
						artifactRefs: [],
						receipt: { todoId: "work-0" },
					},
				},
			});
		}
		if (url.pathname === "/api/toolchain-artifacts")
			return route.fulfill({
				json: {
					artifacts: [
						{
							artifactRevisionId: "artifact:agency.todos@4",
							title: "TODOリスト",
							adapterRefs: ["adapter:task-execution@1"],
							launcher: bundle.artifacts.at(-1)!.launcher,
						},
					],
				},
			});
		if (url.pathname.startsWith("/api/toolchain-artifacts/"))
			return route.fulfill({
				json: {
					artifact: bundle.artifacts.at(-1),
					artifactRevisionId: "artifact:agency.todos@4",
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
		page.getByRole("tab", { name: "進行中", exact: true }),
	).toBeVisible();
	await expect(page.getByRole("table")).toHaveCount(1);
	await expect(
		page.getByRole("table", { name: "進行中", exact: true }).getByRole("row"),
	).toHaveCount(11);
	await expect(
		page.getByRole("table").getByText("todo", { exact: true }).first(),
	).toBeVisible();
	await expect(page.getByRole("button", { name: /をアーカイブ$/ })).toHaveCount(
		10,
	);
	await expect(page.getByRole("combobox")).toHaveCount(1);
	await expect(
		page.getByRole("region", { name: "会話", exact: true }),
	).toBeVisible();
	const panelWidth = await page
		.locator(".artifact-panel")
		.evaluate((el) => el.getBoundingClientRect().width);
	expect(panelWidth).toBeLessThan(650);
	expect(panelWidth).toBeGreaterThan(500);
	const out = resolve("test-results/todo-artifact");
	mkdirSync(out, { recursive: true });
	await page.screenshot({
		path: join(out, "implemented-desktop-v4.png"),
		fullPage: true,
	});
	// Archiving asks first; confirmed, the archive goes to the action route.
	await page
		.getByRole("button", {
			name: "「調査結果をまとめて、比較表を作成する (1)」をアーカイブ",
		})
		.click();
	const confirm = page.getByRole("dialog");
	await expect(
		confirm.getByText("実行中の仕事を止めてアーカイブしますか"),
	).toBeVisible();
	await page.screenshot({
		path: join(out, "implemented-archive-confirm.png"),
		fullPage: true,
	});
	await confirm.getByRole("button", { name: "止めてアーカイブ" }).click();
	await expect.poll(() => actions.length).toBe(1);
	expect(actions[0]).toMatchObject({
		artifactRevisionId: "artifact:agency.todos@4",
		source: "agency-todos",
		actionId: "archive",
		input: { todoId: "work-0" },
	});
	await expect(page.getByRole("dialog")).toHaveCount(0);
	await page.getByRole("button", { name: "進行中の次のページ" }).click();
	await expect(page.getByRole("table").getByRole("row")).toHaveCount(6);
	await expect(page.getByText("15件 · 2 / 2ページ")).toBeVisible();
	await expect(
		page.getByRole("button", { name: "進行中の次のページ" }),
	).toBeDisabled();
	await expect(page.getByRole("table")).toHaveCount(1);
	expect(reads.every((query) => query.state === "active")).toBe(true);
	await page.getByRole("tab", { name: "アーカイブ", exact: true }).click();
	await expect(page.getByRole("table").getByRole("row")).toHaveCount(21);
	expect(reads.at(-1)).toEqual({
		state: "archived",
		pageIndex: 0,
		pageSize: 20,
	});
	await expect(page.getByRole("columnheader")).toHaveText(["依頼内容", "状態"]);
	await expect(page.getByRole("button", { name: /詳細/ })).toHaveCount(0);
	await expect(page.locator("time")).toHaveCount(0);
	await expect(
		page.getByRole("button", { name: "アーカイブの次のページ" }),
	).toHaveCount(0);
	await expect(page.getByRole("combobox")).toHaveCount(0);
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
	const table = page.getByRole("region", {
		name: "アーカイブの表",
		exact: true,
	});
	expect(await table.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
		true,
	);
	await expect(page.getByRole("dialog")).toHaveCount(0);
	empty = true;
	await page.setViewportSize({ width: 1200, height: 870 });
	await page.getByRole("button", { name: "更新", exact: true }).click();
	await expect(
		page.getByText("アーカイブした仕事はありません。"),
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "アーカイブの次のページ" }),
	).toHaveCount(0);
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
