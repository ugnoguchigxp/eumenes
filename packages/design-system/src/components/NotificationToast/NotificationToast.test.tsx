import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotificationToast } from "./NotificationToast";

// Mock the cn utility
vi.mock("@/utils/../", () => ({
	cn: (...classes: (string | undefined)[]) => classes.filter(Boolean).join(" "),
}));

// Mock Lucide icons
vi.mock("lucide-react", () => ({
	AlertCircle: () => <div data-testid="icon-alert-circle" />,
	AlertTriangle: () => <div data-testid="icon-alert-triangle" />,
	CheckCircle2: () => <div data-testid="icon-check-circle" />,
	Info: () => <div data-testid="icon-info" />,
	X: () => <div data-testid="icon-x" />,
	ArrowRight: () => <div data-testid="icon-arrow-right" />,
}));

describe("NotificationToast Component", () => {
	const mockOnClose = vi.fn();
	const mockOnClickLink = vi.fn();

	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe("Rendering Types", () => {
		it("renders info type correctly", () => {
			render(
				<NotificationToast
					type="info"
					title="Info Title"
					message="Info Message"
				/>,
			);

			const toast = screen.getByRole("alert");
			expect(toast).toHaveClass("border-l-info");
			expect(screen.getByTestId("icon-info")).toBeInTheDocument();
			// Verify text color class is passed to icon container
			const iconContainer = screen.getByTestId("icon-info").parentElement;
			expect(iconContainer).toHaveClass("text-info");
		});

		it("renders success type correctly", () => {
			render(
				<NotificationToast
					type="success"
					title="Success Title"
					message="Success Message"
				/>,
			);

			const toast = screen.getByRole("alert");
			expect(toast).toHaveClass("border-l-success");
			expect(screen.getByTestId("icon-check-circle")).toBeInTheDocument();
			const iconContainer =
				screen.getByTestId("icon-check-circle").parentElement;
			expect(iconContainer).toHaveClass("text-success");
		});

		it("renders warning type correctly", () => {
			render(
				<NotificationToast
					type="warning"
					title="Warning Title"
					message="Warning Message"
				/>,
			);

			const toast = screen.getByRole("alert");
			expect(toast).toHaveClass("border-l-warning");
			expect(screen.getByTestId("icon-alert-triangle")).toBeInTheDocument();
			const iconContainer = screen.getByTestId(
				"icon-alert-triangle",
			).parentElement;
			expect(iconContainer).toHaveClass("text-warning");
		});

		it("renders error type correctly", () => {
			render(
				<NotificationToast
					type="error"
					title="Error Title"
					message="Error Message"
				/>,
			);

			const toast = screen.getByRole("alert");
			expect(toast).toHaveClass("border-l-destructive");
			expect(screen.getByTestId("icon-alert-circle")).toBeInTheDocument();
			const iconContainer =
				screen.getByTestId("icon-alert-circle").parentElement;
			expect(iconContainer).toHaveClass("text-destructive");
		});
	});

	describe("Content Rendering", () => {
		it("renders title and message", () => {
			render(
				<NotificationToast
					type="info"
					title="Test Title"
					message="Test Message"
				/>,
			);

			expect(screen.getByText("Test Title")).toBeInTheDocument();
			expect(screen.getByText("Test Message")).toBeInTheDocument();
		});

		it("renders with custom className", () => {
			render(
				<NotificationToast
					type="info"
					title="Title"
					message="Message"
					className="custom-class"
				/>,
			);

			expect(screen.getByRole("alert")).toHaveClass("custom-class");
		});
	});

	describe("Link Interaction", () => {
		it("renders link when onClickLink is provided", () => {
			render(
				<NotificationToast
					type="info"
					title="Title"
					message="Message"
					onClickLink={mockOnClickLink}
					linkLabel="See Details"
				/>,
			);

			expect(screen.getByText("See Details")).toBeInTheDocument();
			expect(screen.getByTestId("icon-arrow-right")).toBeInTheDocument();

			// The entire content functionality is wrapped in a button when link is present
			const linkButton = screen.getByRole("button", { name: /Title/ });
			expect(linkButton).toBeInTheDocument();
		});

		it("uses default link label if not provided", () => {
			render(
				<NotificationToast
					type="info"
					title="Title"
					message="Message"
					onClickLink={mockOnClickLink}
				/>,
			);

			// The default label is '詳細を見る' or fallback
			expect(screen.getByText("詳細を見る")).toBeInTheDocument();
		});

		it("calls onClickLink when clicked via button", () => {
			render(
				<NotificationToast
					type="info"
					title="Title"
					message="Message"
					onClickLink={mockOnClickLink}
				/>,
			);

			const linkButton = screen.getByRole("button", { name: /Title/ });
			fireEvent.click(linkButton);
			expect(mockOnClickLink).toHaveBeenCalledTimes(1);
		});

		it("applies hover shadow when link is present", () => {
			render(
				<NotificationToast
					type="info"
					title="Title"
					message="Message"
					onClickLink={mockOnClickLink}
				/>,
			);

			expect(screen.getByRole("alert")).toHaveClass("hover:shadow-lg");
		});
	});

	describe("Close Button Interaction", () => {
		it("renders close button by default", () => {
			render(
				<NotificationToast
					type="info"
					title="Title"
					message="Message"
					onClose={mockOnClose}
				/>,
			);

			const closeButton = screen.getByLabelText("Close");
			expect(closeButton).toBeInTheDocument();
			expect(screen.getByTestId("icon-x")).toBeInTheDocument();
		});

		it("does not render close button when showCloseButton is false", () => {
			render(
				<NotificationToast
					type="info"
					title="Title"
					message="Message"
					showCloseButton={false}
					onClose={mockOnClose}
				/>,
			);

			expect(screen.queryByLabelText("Close")).not.toBeInTheDocument();
		});

		it("calls onClose when close button is clicked", () => {
			render(
				<NotificationToast
					type="info"
					title="Title"
					message="Message"
					onClose={mockOnClose}
				/>,
			);

			const closeButton = screen.getByLabelText("Close");
			fireEvent.click(closeButton);
			expect(mockOnClose).toHaveBeenCalledTimes(1);
		});

		it("stops propagation when close button is clicked", () => {
			// This tests that clicking close doesn't bubble up,
			// which is important if the toast were nested in something clickable (though unlikely for a toast)
			// or to prevent side effects.
			// The component explicitly calls e.stopPropagation().
			const parentClick = vi.fn();

			render(
				// biome-ignore lint/a11y/noStaticElementInteractions: Mock wrapper needs click
				<div onClick={parentClick} onKeyUp={() => {}}>
					<NotificationToast
						type="info"
						title="Title"
						message="Message"
						onClose={mockOnClose}
					/>
				</div>,
			);

			const closeButton = screen.getByLabelText("Close");
			fireEvent.click(closeButton);

			expect(mockOnClose).toHaveBeenCalled();
			expect(parentClick).not.toHaveBeenCalled();
		});
	});
});
