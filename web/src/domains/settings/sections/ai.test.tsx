import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { AiSection } from "./ai";
import { settingsFixture } from "./fixture";

afterEach(cleanup);
test("ai section renders the routing notice for every purpose", () => {
	const usage = { data: [], isError: false } as never;
	render(
		<AiSection value={settingsFixture()} change={vi.fn()} usage={usage} />,
	);
	expect(screen.getByText(/クラウドへの自動切替/)).toBeTruthy();
	for (const purpose of ["会話", "聞き取り", "読み上げ"])
		expect(screen.getAllByText(purpose).length).toBeGreaterThan(0);
});
