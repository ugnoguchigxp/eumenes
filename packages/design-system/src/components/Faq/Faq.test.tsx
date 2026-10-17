import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it } from "vitest";
import { Faq } from "./Faq";

afterEach(cleanup);

const items = [
	{ question: "質問1", answer: "答え1" },
	{ question: "質問2", answer: "答え2" },
];

it("starts closed and shows only the questions", () => {
	render(<Faq title="FAQ" items={items} />);
	expect(screen.getByRole("heading", { name: "FAQ" })).toBeInTheDocument();
	expect(screen.getByRole("button", { name: "質問1" })).toHaveAttribute(
		"aria-expanded",
		"false",
	);
	expect(screen.queryByText("答え1")).not.toBeInTheDocument();
});

it("opens and closes an item by click and keeps the others independent", () => {
	render(<Faq items={items} />);
	const first = screen.getByRole("button", { name: "質問1" });
	fireEvent.click(first);
	expect(first).toHaveAttribute("aria-expanded", "true");
	expect(screen.getByText("答え1")).toBeVisible();
	expect(screen.queryByText("答え2")).not.toBeInTheDocument();
	fireEvent.click(screen.getByRole("button", { name: "質問2" }));
	expect(screen.getByText("答え1")).toBeInTheDocument();
	expect(screen.getByText("答え2")).toBeInTheDocument();
	fireEvent.click(first);
	expect(screen.queryByText("答え1")).not.toBeInTheDocument();
});

it("toggles with the keyboard", async () => {
	const user = userEvent.setup();
	render(<Faq items={items} />);
	await user.tab();
	expect(screen.getByRole("button", { name: "質問1" })).toHaveFocus();
	await user.keyboard("{Enter}");
	expect(screen.getByText("答え1")).toBeInTheDocument();
	await user.keyboard(" ");
	expect(screen.queryByText("答え1")).not.toBeInTheDocument();
});
