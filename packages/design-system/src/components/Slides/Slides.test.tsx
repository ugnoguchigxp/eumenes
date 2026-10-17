import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it } from "vitest";
import { Slides } from "./Slides";

afterEach(cleanup);

const slides = [
	{ label: "はじめ", content: <p>場面1</p> },
	{ label: "なか", content: <p>場面2</p> },
	{ label: "おわり", content: <p>場面3</p> },
];

it("shows only the first slide with a position indicator and disabled previous", () => {
	render(<Slides title="お話" slides={slides} />);
	expect(screen.getByText("場面1")).toBeVisible();
	expect(screen.getByText("場面2")).not.toBeVisible();
	expect(screen.getByText("1 / 3")).toBeInTheDocument();
	expect(screen.getByRole("button", { name: /前へ/ })).toBeDisabled();
	expect(screen.getByRole("button", { name: /次へ/ })).toBeEnabled();
});

it("moves with next / previous and disables at the last slide", () => {
	render(<Slides slides={slides} />);
	fireEvent.click(screen.getByRole("button", { name: /次へ/ }));
	expect(screen.getByText("場面2")).toBeVisible();
	expect(screen.getByText("2 / 3")).toBeInTheDocument();
	fireEvent.click(screen.getByRole("button", { name: /次へ/ }));
	expect(screen.getByText("3 / 3")).toBeInTheDocument();
	expect(screen.getByRole("button", { name: /次へ/ })).toBeDisabled();
	fireEvent.click(screen.getByRole("button", { name: /前へ/ }));
	expect(screen.getByText("場面2")).toBeVisible();
});

it("jumps by the scene dots named after each slide", () => {
	render(<Slides slides={slides} />);
	fireEvent.click(screen.getByRole("button", { name: "おわり" }));
	expect(screen.getByText("場面3")).toBeVisible();
	expect(screen.getByRole("button", { name: "おわり" })).toHaveAttribute(
		"aria-current",
		"step",
	);
	expect(screen.getByRole("button", { name: "はじめ" })).not.toHaveAttribute(
		"aria-current",
	);
});

it("moves with the left and right arrow keys while focus is inside", async () => {
	const user = userEvent.setup();
	render(<Slides slides={slides} />);
	await user.click(screen.getByRole("button", { name: "はじめ" }));
	await user.keyboard("{ArrowRight}");
	expect(screen.getByText("場面2")).toBeVisible();
	await user.keyboard("{ArrowRight}{ArrowRight}");
	expect(screen.getByText("場面3")).toBeVisible();
	await user.keyboard("{ArrowLeft}");
	expect(screen.getByText("場面2")).toBeVisible();
	await user.keyboard("{ArrowLeft}{ArrowLeft}");
	expect(screen.getByText("場面1")).toBeVisible();
});

it("leaves arrow keys to inputs placed inside a slide", async () => {
	const user = userEvent.setup();
	render(
		<Slides
			slides={[
				{ label: "入力", content: <input type="range" aria-label="値" /> },
				{ label: "次", content: <p>次の場面</p> },
			]}
		/>,
	);
	screen.getByLabelText("値").focus();
	await user.keyboard("{ArrowRight}");
	expect(screen.getByText("次の場面")).not.toBeVisible();
});

it("keeps the index valid when slides shrink", () => {
	const { rerender } = render(<Slides slides={slides} />);
	fireEvent.click(screen.getByRole("button", { name: "おわり" }));
	rerender(<Slides slides={slides.slice(0, 2)} />);
	expect(screen.getByText("2 / 2")).toBeInTheDocument();
});

it("keeps what was typed inside a slide while moving between slides", async () => {
	const user = userEvent.setup();
	render(
		<Slides
			slides={[
				{ label: "入力", content: <input aria-label="メモ" /> },
				{ label: "次", content: <p>次の場面</p> },
			]}
		/>,
	);
	await user.type(screen.getByLabelText("メモ"), "下書き");
	fireEvent.click(screen.getByRole("button", { name: /次へ/ }));
	expect(screen.getByLabelText("メモ")).not.toBeVisible();
	fireEvent.click(screen.getByRole("button", { name: /前へ/ }));
	expect(screen.getByLabelText("メモ")).toBeVisible();
	expect(screen.getByLabelText("メモ")).toHaveValue("下書き");
});
