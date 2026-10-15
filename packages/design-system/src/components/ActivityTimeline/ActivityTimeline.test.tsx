import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { ActivityTimeline } from "./ActivityTimeline";

afterEach(cleanup);
const first = {
	id: "first",
	at: "2026-10-15T00:00:00.000Z",
	title: "作業を開始しました",
	status: "working" as const,
};
test("empty and disconnected states remain readable and do not invent progress", () => {
	render(<ActivityTimeline entries={[]} connected={false} />);
	expect(screen.getByText("まだ動きの記録はありません")).toBeVisible();
	expect(screen.getByRole("status").textContent).toContain("保存済み");
});
test("activity is text; details are folded and completion has a text label", () => {
	const { container } = render(
		<ActivityTimeline
			entries={[
				{
					...first,
					status: "completed",
					detail: "<script>window.bad=true</script>",
					truncated: true,
				},
			]}
		/>,
	);
	expect(container.querySelector("script")).toBeNull();
	expect(container.querySelector("details")?.open).toBe(false);
	expect(screen.getByText("終了")).toBeVisible();
	expect(screen.getByText(/一部を省略/)).toBeVisible();
});
test("scrolling up pauses following; new entries keep reading position until latest is requested", () => {
	const { rerender } = render(<ActivityTimeline entries={[first]} />);
	const region = screen.getByLabelText("動きの記録");
	Object.defineProperty(region, "scrollHeight", {
		configurable: true,
		value: 500,
	});
	Object.defineProperty(region, "clientHeight", {
		configurable: true,
		value: 100,
	});
	region.scrollTop = 40;
	fireEvent.scroll(region);
	expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(
		false,
	);
	rerender(
		<ActivityTimeline
			entries={[first, { ...first, id: "second", title: "次の動き" }]}
		/>,
	);
	expect(region.scrollTop).toBe(40);
	fireEvent.click(screen.getByRole("button", { name: "最新へ" }));
	expect(region.scrollTop).toBe(500);
});
