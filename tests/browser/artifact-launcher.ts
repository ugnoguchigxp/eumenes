import type { Page } from "@playwright/test";

/** Opens an artifact from the top-right launcher; saved items do not open on page load. */
export async function openFromLauncher(page: Page, label: string) {
	await page.getByRole("button", { name: "アーティファクトを開く" }).click();
	await page.getByRole("menuitem", { name: label, exact: true }).click();
}
