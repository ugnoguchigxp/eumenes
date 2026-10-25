import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { WorkResultPanel } from "./WorkResultPanel";
test("a rejected answer stays editable and a successful answer clears it", async () => {
	const user = userEvent.setup(),
		answer = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
	render(
		<WorkResultPanel
			title="確認"
			status="回答待ち"
			question={{ id: "q", prompt: "対象は？", choices: [] }}
			onAnswer={answer}
		/>,
	);
	const field = screen.getByRole("textbox", { name: "質問への回答" });
	await user.type(field, "対象A");
	await user.click(screen.getByRole("button", { name: "回答を送る" }));
	expect(field).toHaveValue("対象A");
	await user.click(screen.getByRole("button", { name: "回答を送る" }));
	await waitFor(() => expect(field).toHaveValue(""));
	expect(screen.queryByRole("button", { name: "取消" })).toBeNull();
});
