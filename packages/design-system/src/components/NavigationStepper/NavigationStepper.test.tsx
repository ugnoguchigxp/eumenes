import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
	type NavigationStep,
	NavigationStepper,
} from "@/components/NavigationStepper/NavigationStepper";

const steps: NavigationStep[] = [
	{ id: "1", title: "Step 1", description: "Desc 1" },
	{ id: "2", title: "Step 2", description: "Desc 2" },
	{ id: "3", title: "Step 3", disabled: true },
];

describe("NavigationStepper", () => {
	const user = userEvent.setup();

	it("renders horizontal steps correctly", () => {
		render(<NavigationStepper steps={steps} activeStep={0} />);

		expect(screen.getByText("Step 1")).toBeInTheDocument();
		expect(screen.getByText("Step 2")).toBeInTheDocument();
		expect(screen.getByText("Step 3")).toBeInTheDocument();

		// Step 1 is active (current)
		screen.getByText("1"); // Circle number
		// Circle styling check is hard, but we can check container class if we want, or visual regression.
		// Let's check logic: active step 0 means step 1 is current.
		// Check aria-current on button if clickable.
		// If no onStepChange, buttons are divs?
		// Code: if (!onStepChange) return <div ...>

		// So passed as non-interactive divs.
		expect(screen.queryByRole("button")).not.toBeInTheDocument();
	});

	it("renders interactive buttons when onStepChange provided", async () => {
		const onStepChange = vi.fn();
		render(
			<NavigationStepper
				steps={steps}
				activeStep={0}
				onStepChange={onStepChange}
			/>,
		);

		const buttons = screen.getAllByRole("button");
		expect(buttons).toHaveLength(3);

		// Click Step 2
		const step2Button = buttons[1];
		expect(step2Button).toBeDefined();
		if (step2Button) {
			await user.click(step2Button);
		}
		expect(onStepChange).toHaveBeenCalledWith(1);
	});

	it("does not trigger change on disabled step", async () => {
		const onStepChange = vi.fn();
		render(
			<NavigationStepper
				steps={steps}
				activeStep={0}
				onStepChange={onStepChange}
			/>,
		);

		// Step 3 is disabled
		// Step 3 is disabled. Button contains "3".
		const step3Btn = screen.getByRole("button", { name: "3" });
		// renderStepButton wraps content.
		// content includes circle and title div.
		// The button contains all of it.
		// We can find by text 'Step 3' and closest button.

		await user.click(step3Btn);
		expect(onStepChange).not.toHaveBeenCalled();
		expect(step3Btn).toBeDisabled();
	});

	it("renders completed steps with checkmark", () => {
		render(<NavigationStepper steps={steps} activeStep={1} />);
		// Step 1 is completed (index 0 < active 1).
		// Should have Check icon.
		// Check icon from lucide-react. We can't easily query SVG by name without aria-label on SVG.
		// But we check "1" is NOT in the document for step 1?
		// Wait, "1" is replaced by Check.
		// Step 2 (active) shows "2".

		expect(screen.queryByText("1")).not.toBeInTheDocument();
		expect(screen.getByText("2")).toBeInTheDocument();
	});

	it("clamps active step index", () => {
		render(<NavigationStepper steps={steps} activeStep={10} />);
		// Should clamp to max index 2.
		// So Step 3 is current.
		// "3" should be displayed (or if it was previously completed, checkmark? No, it's current).
		// "1" and "2" should be checkmarks.
		expect(screen.queryByText("1")).not.toBeInTheDocument();
		expect(screen.queryByText("2")).not.toBeInTheDocument();
		expect(screen.getByText("3")).toBeInTheDocument();
	});

	it("renders content using renderStepContent", () => {
		render(
			<NavigationStepper
				steps={steps}
				activeStep={0}
				renderStepContent={(step) => <div>Content: {step.title}</div>}
			/>,
		);
		expect(screen.getByText("Content: Step 1")).toBeInTheDocument();
	});

	it("renders vertical list", () => {
		render(
			<NavigationStepper steps={steps} activeStep={0} orientation="vertical" />,
		);
		// Just checking it renders without crashing and contains texts.
		// Structure is different (nav > div.grid).
		expect(screen.getByRole("navigation")).toBeInTheDocument();
	});

	it("renders vertical accordion", () => {
		render(
			<NavigationStepper
				steps={steps}
				activeStep={0}
				orientation="vertical"
				variant="accordion"
			/>,
		);
		expect(screen.getByRole("navigation")).toBeInTheDocument();
	});
});
