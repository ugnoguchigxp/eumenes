import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { RadioButtonGroup } from "./RadioButtonGroup";

const options = [
	{ value: "brief", label: "短く" },
	{ value: "detail", label: "詳しく" },
];

describe("RadioButtonGroup", () => {
	it("selects from the entire label and keeps separately named groups independent", async () => {
		function Example() {
			const [answer, setAnswer] = useState("");
			return (
				<>
					<RadioButtonGroup
						label="回答"
						options={options}
						value={answer}
						onValueChange={setAnswer}
						required
					/>
					<RadioButtonGroup
						label="別の回答"
						options={[{ value: "other", label: "別の選択" }]}
						value="other"
						onValueChange={() => {}}
					/>
				</>
			);
		}
		render(<Example />);
		const user = userEvent.setup();
		await user.click(screen.getByText("短く"));
		expect(screen.getByRole("radio", { name: "短く" })).toBeChecked();
		await user.click(screen.getByText("詳しく"));
		expect(screen.getByRole("radio", { name: "詳しく" })).toBeChecked();
		expect(screen.getByRole("radio", { name: "短く" })).not.toBeChecked();
		expect(screen.getByRole("radio", { name: "別の選択" })).toBeChecked();
	});
	it("preserves a submitted selection while preventing further changes", async () => {
		const change = vi.fn();
		render(
			<RadioButtonGroup
				label="回答"
				options={options}
				value="brief"
				onValueChange={change}
				disabled
			/>,
		);
		await userEvent.click(screen.getByText("詳しく"));
		expect(change).not.toHaveBeenCalled();
		expect(screen.getByRole("radio", { name: "短く" })).toBeChecked();
		expect(screen.getByRole("radio", { name: "詳しく" })).toBeDisabled();
	});
});
