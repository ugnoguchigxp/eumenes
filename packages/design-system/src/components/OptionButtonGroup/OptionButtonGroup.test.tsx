import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
	OptionButtonGroup,
	type OptionButtonItem,
} from "../../../src/components/OptionButtonGroup/OptionButtonGroup";

type DensityOption = "compact" | "normal" | "spacious";
const options: OptionButtonItem<DensityOption>[] = [
	{ value: "compact", label: "Compact mode", description: "Tighter spacing" },
	{ value: "normal", label: "Normal mode" },
	{
		value: "spacious",
		label: "Spacious mode",
		description: "More breathing room",
	},
];

describe("OptionButtonGroup", () => {
	it("renders all option buttons with their labels and optional descriptions", () => {
		render(
			<OptionButtonGroup
				value="normal"
				onChange={() => {}}
				options={options}
			/>,
		);

		expect(screen.getByText("Compact mode")).toBeInTheDocument();
		expect(screen.getByText("Tighter spacing")).toBeInTheDocument();
		expect(screen.getByText("Spacious mode")).toBeInTheDocument();
		expect(screen.getByText("Normal mode")).toBeInTheDocument();
	});

	it("calls onChange with the option value when a non-null button is clicked (single)", async () => {
		const handleChange = vi.fn();
		render(
			<OptionButtonGroup
				value="compact"
				onChange={handleChange}
				options={options}
			/>,
		);

		// Use regex to match since button text includes description ("Spacious mode More breathing room")
		await fireEvent.click(
			screen.getByRole("button", { name: /Spacious mode/ }),
		);
		expect(handleChange).toHaveBeenCalledWith("spacious");
	});

	it("renders the null option button when allowNull is enabled and uses the provided nullLabel", async () => {
		const handleChange = vi.fn();
		render(
			<OptionButtonGroup
				value={null}
				onChange={handleChange}
				options={options}
				allowNull
				nullLabel="Auto"
				columns={3}
			/>,
		);

		const nullButton = screen.getByRole("button", { name: "Auto" });
		expect(nullButton).toBeInTheDocument();
		// 'option-active' variant renders as border-primary bg-primary/10
		expect(nullButton).toHaveClass("border-primary");

		await fireEvent.click(nullButton);
		expect(handleChange).toHaveBeenCalledWith(null);
	});

	it("applies the correct grid column class and merges custom className", () => {
		const { container } = render(
			<OptionButtonGroup
				value="compact"
				onChange={() => {}}
				options={options}
				columns={4}
				className="custom-grid"
			/>,
		);

		const grid = container.firstElementChild;
		expect(grid).toHaveClass("grid", "grid-cols-4", "gap-2", "custom-grid");
	});

	describe("Multi-select Mode", () => {
		it("renders multiple selected options correctly", () => {
			render(
				<OptionButtonGroup
					multiple
					value={["compact", "spacious"]}
					onChange={() => {}}
					options={options}
				/>,
			);

			const compactBtn = screen.getByRole("button", { name: /Compact mode/ });
			const normalBtn = screen.getByRole("button", { name: /Normal mode/ });
			const spaciousBtn = screen.getByRole("button", { name: /Spacious mode/ });

			expect(compactBtn).toHaveClass("border-primary"); // active
			expect(normalBtn).not.toHaveClass("border-primary"); // inactive
			expect(spaciousBtn).toHaveClass("border-primary"); // active
		});

		it("adds value to array when clicking unselected item", async () => {
			const handleChange = vi.fn();
			render(
				<OptionButtonGroup
					multiple
					value={["compact"]}
					onChange={handleChange}
					options={options}
				/>,
			);

			await fireEvent.click(
				screen.getByRole("button", { name: /Normal mode/ }),
			);
			expect(handleChange).toHaveBeenCalledWith(["compact", "normal"]);
		});

		it("removes value from array when clicking selected item", async () => {
			const handleChange = vi.fn();
			render(
				<OptionButtonGroup
					multiple
					value={["compact", "normal"]}
					onChange={handleChange}
					options={options}
				/>,
			);

			await fireEvent.click(
				screen.getByRole("button", { name: /Compact mode/ }),
			);
			expect(handleChange).toHaveBeenCalledWith(["normal"]);
		});
	});

	describe("Edge Cases", () => {
		it("does not trigger multi logic in single mode", async () => {
			// Technically handleSingleChange handles it, but just ensuring coverage
			const handleChange = vi.fn();
			render(
				<OptionButtonGroup
					value="compact"
					onChange={handleChange}
					options={options}
				/>,
			);

			await fireEvent.click(
				screen.getByRole("button", { name: /Normal mode/ }),
			);
			// Expect single string, not array
			expect(handleChange).toHaveBeenCalledWith("normal");
		});

		it("uses default columns=2 and empty className", () => {
			const { container } = render(
				<OptionButtonGroup
					value="compact"
					onChange={() => {}}
					options={options}
				/>,
			);
			const grid = container.firstElementChild;
			expect(grid).toHaveClass("grid-cols-2");
		});

		it('uses default "Auto" label if nullLabel missing', () => {
			render(
				<OptionButtonGroup
					value={null}
					onChange={() => {}}
					options={options}
					allowNull
				/>,
			);
			expect(screen.getByText("自動")).toBeInTheDocument();
		});
	});
});
