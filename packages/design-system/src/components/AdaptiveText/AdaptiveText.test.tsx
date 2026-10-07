import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AdaptiveText } from "./AdaptiveText";

// Mock ResizeObserver
let resizeObserverCallback: ResizeObserverCallback | null = null;
global.ResizeObserver = class ResizeObserver {
	constructor(cb: ResizeObserverCallback) {
		resizeObserverCallback = cb;
	}
	observe = vi.fn();
	unobserve = vi.fn();
	disconnect = vi.fn();
};

describe("AdaptiveText", () => {
	// Helper to mock dimensions
	const mockDimensions = (containerWidth: number, textWidth: number) => {
		// We need to target the elements created by render.
		// Since we can't easily access ref.current from outside before render,
		// we assume we can spy on the property getter or set it on the element after render?
		// But useLayoutEffect runs immediately after render.
		// So we need to mock dimensions BEFORE they are read.
		// We can spy on HTMLElement.prototype.clientWidth/scrollWidth, but identifying *which* element is tricky.
		// Alternative: We can use `Object.defineProperty` on the specific instance if we can get it?
		// No.
		// Strategy: Spy prototype but return based on some identify or just return fixed values for the "next" read?
		// Simplified: The component reads container.clientWidth and textElement.scrollWidth.
		// The container has class 'adaptive-text-container'.
		// The text element is a span.

		vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(
			function (this: HTMLElement) {
				if (this.classList.contains("adaptive-text-container")) {
					return containerWidth;
				}
				return 0;
			},
		);

		vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(
			function (this: HTMLElement) {
				// The text span is the child of container.
				// We can check if parent has class adaptive-text-container?
				if (this.parentElement?.classList.contains("adaptive-text-container")) {
					return textWidth;
				}
				return 0;
			},
		);
	};

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("renders normally when text fits", () => {
		mockDimensions(100, 80); // 80 < 100 -> ratio 0.8
		render(<AdaptiveText text="Short Text" width={100} />);

		const span = screen.getByText("Short Text");
		expect(span).toHaveStyle({ transform: "none" });
	});

	it("scales down when text exceeds width by <= 30%", () => {
		mockDimensions(100, 120); // 120 / 100 = 1.2
		render(<AdaptiveText text="Medium Text" width={100} />);

		const span = screen.getByText("Medium Text");
		// Scale should be 1 / 1.2 = 0.8333...
		// Check transform property contains scale
		// Note: style transform might be "scale(0.83333...)"
		expect(span.style.transform).toMatch(/scale\(0\.833\d*\)/);
	});

	it("truncates when text exceeds width by > 30%", () => {
		mockDimensions(100, 150); // 150 / 100 = 1.5
		render(<AdaptiveText text="Long Text" width={100} />);

		const container = screen.getByText("Long Text").parentElement;
		expect(container).toHaveStyle({
			textOverflow: "ellipsis",
			overflow: "hidden",
		});
		expect(screen.getByText("Long Text")).toHaveStyle({ transform: "none" });
		expect(container).toHaveAttribute("title", "Long Text");
	});

	it("handles string px width", () => {
		mockDimensions(200, 100);
		render(<AdaptiveText text="Text" width="200px" />);
		// Logic uses Number.parseFloat("200px") -> 200
		const span = screen.getByText("Text");
		expect(span).toBeInTheDocument();
	});

	it("measures container width via clientWidth if width prop is missing", () => {
		mockDimensions(300, 100);
		render(<AdaptiveText text="Auto Width" />);
		// Should fit
		const span = screen.getByText("Auto Width");
		expect(span).toHaveStyle({ transform: "none" });
	});

	it("observes resize when width is not provided", () => {
		mockDimensions(100, 80); // Initial
		render(<AdaptiveText text="Resizing" />);

		const span = screen.getByText("Resizing");
		expect(span).toHaveStyle({ transform: "none" });

		// Trigger resize
		mockDimensions(50, 80); // Now it's too small (80 > 50 * 1.3 => 1.6 ratio -> truncate)
		act(() => {
			if (resizeObserverCallback) {
				resizeObserverCallback([], {} as ResizeObserver);
			}
		});

		// Should now be truncated
		const container = span.parentElement;
		expect(container).toHaveStyle({ textOverflow: "ellipsis" });
	});

	it("renders as different element (polymorphic)", () => {
		mockDimensions(100, 50);
		render(<AdaptiveText text="Header" as="h1" />);
		const element = screen.getByText("Header").parentElement;
		expect(element?.tagName).toBe("H1");
	});

	it("handles zero available width (early return)", () => {
		mockDimensions(0, 100);
		render(<AdaptiveText text="Hidden" />);
		// Should default to scale 1, no truncation (reset state)
		// or rather, keep initial state.
		// Logic: checkSize resets to scale 1, truncated false.
		// Then availability check returns.
		const span = screen.getByText("Hidden");
		expect(span).toHaveStyle({ transform: "none" });
		const container = span.parentElement;
		expect(container).not.toHaveAttribute("title");
	});

	it("fits perfectly at ratio 1.0", () => {
		mockDimensions(100, 100);
		render(<AdaptiveText text="Perfect" width={100} />);
		const span = screen.getByText("Perfect");
		expect(span).toHaveStyle({ transform: "none" });
	});

	it("scales exactly at ratio 1.3", () => {
		mockDimensions(100, 130);
		render(<AdaptiveText text="Limit" width={100} />);
		const span = screen.getByText("Limit");
		// 1 / 1.3 = 0.76923...
		expect(span.style.transform).toMatch(/scale\(0\.769\d*\)/);
	});

	it("truncates just above ratio 1.3", () => {
		mockDimensions(100, 131);
		render(<AdaptiveText text="Over Limit" width={100} />);
		const container = screen.getByText("Over Limit").parentElement;
		expect(container).toHaveStyle({ textOverflow: "ellipsis" });
	});

	it("handles disconnect of observer on unmount", () => {
		const disconnectSpy = vi.fn();
		// Override the mock for this test
		global.ResizeObserver = class ResizeObserver {
			observe = vi.fn();
			unobserve = vi.fn();
			disconnect = disconnectSpy;
		} as unknown as typeof ResizeObserver;

		const { unmount } = render(<AdaptiveText text="Unmount" />);
		unmount();
		expect(disconnectSpy).toHaveBeenCalled();
	});

	it("returns undefined cleanup if width is provided", () => {
		// This is hard to test directly via rendering as it's an internal useEffect return.
		// But we can verify no observer is created.
		const observerSpy = vi.fn();
		global.ResizeObserver = class ResizeObserver {
			observe = observerSpy;
			unobserve = vi.fn();
			disconnect = vi.fn();
		} as unknown as typeof ResizeObserver;

		render(<AdaptiveText text="Fixed" width={100} />);
		expect(observerSpy).not.toHaveBeenCalled();
	});
});
