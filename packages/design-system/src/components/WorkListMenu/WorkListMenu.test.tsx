import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { WorkListMenu } from "./WorkListMenu";
test("icon button opens an overlay menu, highlights the selection and returns focus after choosing", async () => {
	const user = userEvent.setup(),
		select = vi.fn();
	render(
		<WorkListMenu
			items={[
				{ id: "one", label: "最初の仕事", status: "完了" },
				{ id: "two", label: "次の仕事", status: "作業中" },
			]}
			selectedId="one"
			onSelect={select}
		/>,
	);
	expect(screen.queryByRole("combobox")).toBeNull();
	const trigger = screen.getByRole("button", { name: "仕事一覧" });
	await user.click(trigger);
	expect(
		await screen.findByRole("menu", { name: "依頼した仕事" }),
	).toBeVisible();
	expect(screen.getByRole("menuitem", { name: /最初の仕事/ })).toHaveAttribute(
		"aria-current",
		"true",
	);
	await user.click(screen.getByRole("menuitem", { name: /次の仕事/ }));
	expect(select).toHaveBeenCalledWith("two");
	await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
	await waitFor(() => expect(trigger).toHaveFocus());
	await user.click(trigger);
	await user.keyboard("{Escape}");
	await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
});
