import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { menuKeyDown } from "./menuKeyboard";

function Menu() {
	return (
		<div role="menu" tabIndex={-1} onKeyDown={menuKeyDown}>
			<button type="button" role="menuitem">
				一つ目
			</button>
			<button type="button" role="menuitem" disabled>
				無効
			</button>
			<button type="button" role="menuitem">
				二つ目
			</button>
			<button type="button">削除</button>
		</div>
	);
}

describe("menuKeyDown", () => {
	it("moves focus between enabled menu items and wraps around", () => {
		render(<Menu />);
		const first = screen.getByRole("menuitem", { name: "一つ目" });
		const second = screen.getByRole("menuitem", { name: "二つ目" });
		first.focus();
		fireEvent.keyDown(first, { key: "ArrowDown" });
		expect(second).toHaveFocus();
		fireEvent.keyDown(second, { key: "ArrowDown" });
		expect(first).toHaveFocus();
		fireEvent.keyDown(first, { key: "ArrowUp" });
		expect(second).toHaveFocus();
		fireEvent.keyDown(second, { key: "Home" });
		expect(first).toHaveFocus();
		fireEvent.keyDown(first, { key: "End" });
		expect(second).toHaveFocus();
	});

	it("leaves other keys alone", () => {
		render(<Menu />);
		const first = screen.getByRole("menuitem", { name: "一つ目" });
		first.focus();
		const allowed = fireEvent.keyDown(first, { key: "a" });
		expect(allowed).toBe(true);
		expect(first).toHaveFocus();
	});
});
