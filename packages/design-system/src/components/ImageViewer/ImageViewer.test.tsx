import {
	act,
	fireEvent,
	render,
	renderHook,
	screen,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	ImageViewer,
	ImageWithPreview,
	useImageViewer,
} from "../../../src/components/ImageViewer/ImageViewer";

// Mock the cn utility
vi.mock("@/utils/../", () => ({
	cn: (...classes: (string | undefined)[]) => classes.filter(Boolean).join(" "),
}));

// Mock Modal component
vi.mock("../../../src/components/Modal", () => ({
	Modal: ({
		open,
		children,
		onOpenChange,
	}: {
		open?: boolean;
		children?: React.ReactNode;
		onOpenChange: (open: boolean) => void;
	}) =>
		open ? (
			<div data-testid="modal">
				<button
					type="button"
					onClick={() => onOpenChange(false)}
					aria-label="Close"
				>
					Close
				</button>
				{children}
			</div>
		) : null,
}));

describe("ImageViewer Component", () => {
	const mockOnOpenChange = vi.fn();

	beforeEach(() => {
		vi.clearAllMocks();
		delete (globalThis as unknown as Record<string, unknown>).t;
		delete (globalThis as unknown as Record<string, unknown>).log;
	});

	describe("ImageViewer", () => {
		it("renders when open", () => {
			render(
				<ImageViewer
					src="test.jpg"
					open={true}
					onOpenChange={mockOnOpenChange}
				/>,
			);

			expect(screen.getByTestId("modal")).toBeInTheDocument();
			expect(screen.getByRole("img")).toHaveAttribute("src", "test.jpg");
		});

		it("does not render when closed", () => {
			render(
				<ImageViewer
					src="test.jpg"
					open={false}
					onOpenChange={mockOnOpenChange}
				/>,
			);

			expect(screen.queryByTestId("modal")).not.toBeInTheDocument();
		});

		it("missing src does not trigger a page request or require host globals", () => {
			render(<ImageViewer src="" open={true} onOpenChange={vi.fn()} />);
			expect(screen.getByRole("img")).not.toHaveAttribute("src");
		});

		it("closes on Escape key without host globals", () => {
			const onOpenChange = vi.fn();

			render(
				<ImageViewer src="test.jpg" open={true} onOpenChange={onOpenChange} />,
			);

			fireEvent.keyDown(window, { key: "Escape" });
			expect(onOpenChange).toHaveBeenCalledWith(false);
		});
	});

	describe("useImageViewer Hook", () => {
		it("manages state correctly", () => {
			const { result } = renderHook(() => useImageViewer());

			expect(result.current.open).toBe(false);
			expect(result.current.src).toBe(null);

			act(() => {
				result.current.show("image.jpg", "Alt Text");
			});

			expect(result.current.open).toBe(true);
			expect(result.current.src).toBe("image.jpg");
			expect(result.current.alt).toBe("Alt Text");

			act(() => {
				result.current.hide();
			});

			expect(result.current.open).toBe(false);
		});
	});

	describe("ImageWithPreview", () => {
		it("renders thumbnail and opens viewer on click", () => {
			render(<ImageWithPreview src="thumb.jpg" alt="Thumb" />);

			const thumb = screen.getByRole("button");
			expect(thumb).toBeInTheDocument();

			fireEvent.click(thumb);

			expect(screen.getByTestId("modal")).toBeInTheDocument();
			expect(screen.getAllByRole("img")[1]).toHaveAttribute("src", "thumb.jpg");
		});

		it("opens viewer on Enter key", () => {
			render(<ImageWithPreview src="thumb.jpg" />);

			const thumb = screen.getByRole("button");
			fireEvent.keyDown(thumb, { key: "Enter" });

			expect(screen.getByTestId("modal")).toBeInTheDocument();
		});
	});
});
