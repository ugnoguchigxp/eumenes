import { fireEvent, render, renderHook, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CalendarProvider, useCalendarSettings } from "./CalendarContext";

// Test component to consume the context
const TestConsumer = () => {
	const {
		secondaryCalendar,
		preferLocalCalendar,
		setSecondaryCalendar,
		setPreferLocalCalendar,
	} = useCalendarSettings();

	return (
		<div>
			<div data-testid="secondary-calendar">{secondaryCalendar}</div>
			<div data-testid="prefer-local">{preferLocalCalendar.toString()}</div>
			<button
				type="button"
				onClick={() => setSecondaryCalendar("japanese")}
				data-testid="set-secondary"
			>
				Set Japanese
			</button>
			<button
				type="button"
				onClick={() => setPreferLocalCalendar(true)}
				data-testid="set-prefer-local"
			>
				Set Prefer Local
			</button>
		</div>
	);
};

describe("CalendarContext", () => {
	it("provides default values when no props are passed", () => {
		render(
			<CalendarProvider>
				<TestConsumer />
			</CalendarProvider>,
		);

		expect(screen.getByTestId("secondary-calendar")).toHaveTextContent("none");
		expect(screen.getByTestId("prefer-local")).toHaveTextContent("false");
	});

	it("can initialize with custom default values", () => {
		render(
			<CalendarProvider
				defaultSecondaryCalendar="islamic"
				defaultPreferLocalCalendar={true}
			>
				<TestConsumer />
			</CalendarProvider>,
		);

		expect(screen.getByTestId("secondary-calendar")).toHaveTextContent(
			"islamic",
		);
		expect(screen.getByTestId("prefer-local")).toHaveTextContent("true");
	});

	it("updates secondary calendar setting", () => {
		render(
			<CalendarProvider>
				<TestConsumer />
			</CalendarProvider>,
		);

		fireEvent.click(screen.getByTestId("set-secondary"));
		expect(screen.getByTestId("secondary-calendar")).toHaveTextContent(
			"japanese",
		);
	});

	it("updates prefer local calendar setting", () => {
		render(
			<CalendarProvider>
				<TestConsumer />
			</CalendarProvider>,
		);

		fireEvent.click(screen.getByTestId("set-prefer-local"));
		expect(screen.getByTestId("prefer-local")).toHaveTextContent("true");
	});

	it("returns default values when used outside provider", () => {
		// Suppress console.error if the hook logs errors when context is missing (though implementation just returns defaults)

		const { result } = renderHook(() => useCalendarSettings());

		expect(result.current.secondaryCalendar).toBe("none");
		expect(result.current.preferLocalCalendar).toBe(false);

		// Test the dummy setter functions for safety coverage
		expect(() => result.current.setSecondaryCalendar("japanese")).not.toThrow();
		expect(() => result.current.setPreferLocalCalendar(true)).not.toThrow();
	});
});
