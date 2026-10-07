import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmModal } from "./ConfirmModal";

// Mock dependencies
vi.mock("../../../src/components/Modal/Modal", () => ({
	Modal: ({
		open,
		onOpenChange,
		title,
		description,
		footer,
		children,
	}: {
		open?: boolean;
		onOpenChange: (open: boolean) => void;
		title?: string;
		description?: string;
		footer?: React.ReactNode;
		children?: React.ReactNode;
	}) => (
		<div data-testid="modal" data-open={open}>
			<h2 data-testid="modal-title">{title}</h2>
			{description !== undefined && (
				<p data-testid="modal-description">{description}</p>
			)}
			<div data-testid="modal-content">{children}</div>
			<div data-testid="modal-footer">{footer}</div>
			{open && (
				<button
					data-testid="modal-close"
					type="button"
					onClick={() => onOpenChange(false)}
				>
					Close Modal
				</button>
			)}
		</div>
	),
}));

vi.mock("../../../src/components/Button/Button", () => ({
	Button: ({
		children,
		variant,
		onClick,
		disabled,
		loading,
	}: {
		children?: React.ReactNode;
		variant?: string;
		onClick?: () => void;
		disabled?: boolean;
		loading?: boolean;
	}) => (
		<button
			data-variant={variant}
			data-loading={loading || false}
			disabled={disabled || loading}
			type="button"
			onClick={onClick}
		>
			{loading ? "Loading..." : children}
		</button>
	),
}));

// Mock translation function
const mockT = vi.fn((key: string) => key);
vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: mockT,
	}),
}));

describe("ConfirmModal Component", () => {
	const mockOnOpenChange = vi.fn();
	const mockOnConfirm = vi.fn();
	const mockOnCancel = vi.fn();

	beforeEach(() => {
		vi.clearAllMocks();
		mockT.mockImplementation((key: string) => key);
	});

	describe("Basic Rendering", () => {
		it("renders modal when open is true", () => {
			render(
				<ConfirmModal
					open={true}
					onOpenChange={mockOnOpenChange}
					title="Test Title"
					onConfirm={mockOnConfirm}
				/>,
			);

			const modal = screen.getByTestId("modal");
			expect(modal).toBeInTheDocument();
			expect(modal).toHaveAttribute("data-open", "true");
		});

		it("does not render modal when open is false", () => {
			render(
				<ConfirmModal
					open={false}
					onOpenChange={mockOnOpenChange}
					title="Test Title"
					onConfirm={mockOnConfirm}
				/>,
			);

			const modal = screen.getByTestId("modal");
			expect(modal).toHaveAttribute("data-open", "false");
		});

		it("renders title correctly", () => {
			render(
				<ConfirmModal
					open={true}
					onOpenChange={mockOnOpenChange}
					title="Confirmation Title"
					onConfirm={mockOnConfirm}
				/>,
			);

			const title = screen.getByTestId("modal-title");
			expect(title).toHaveTextContent("Confirmation Title");
		});

		it("renders description when provided", () => {
			render(
				<ConfirmModal
					open={true}
					onOpenChange={mockOnOpenChange}
					title="Test Title"
					description="Are you sure you want to proceed?"
					onConfirm={mockOnConfirm}
				/>,
			);

			const description = screen.getByTestId("modal-description");
			expect(description).toHaveTextContent(
				"Are you sure you want to proceed?",
			);
		});

		it("does not render description when not provided", () => {
			render(
				<ConfirmModal
					open={true}
					onOpenChange={mockOnOpenChange}
					title="Test Title"
					onConfirm={mockOnConfirm}
				/>,
			);

			expect(screen.queryByTestId("modal-description")).not.toBeInTheDocument();
		});
	});

	describe("Button Rendering", () => {
		it("renders both confirm and cancel buttons by default", () => {
			render(
				<ConfirmModal
					open={true}
					onOpenChange={mockOnOpenChange}
					title="Test Title"
					onConfirm={mockOnConfirm}
				/>,
			);

			const buttons = screen.getAllByRole("button");
			expect(buttons).toHaveLength(3); // 2 footer buttons + 1 modal close

			const cancelButton = screen.getByText("Cancel");
			const confirmButton = screen.getByText("Confirm");

			expect(cancelButton).toBeInTheDocument();
			expect(confirmButton).toBeInTheDocument();
			expect(cancelButton).toHaveAttribute("data-variant", "outline");
			expect(confirmButton).toHaveAttribute("data-variant", "default");
		});

		it("hides cancel button when showCancel is false", () => {
			render(
				<ConfirmModal
					open={true}
					onOpenChange={mockOnOpenChange}
					title="Test Title"
					onConfirm={mockOnConfirm}
					showCancel={false}
				/>,
			);

			expect(screen.queryByText("Cancel")).not.toBeInTheDocument();
			expect(screen.getByText("Confirm")).toBeInTheDocument();
		});

		it("uses custom button text when provided", () => {
			render(
				<ConfirmModal
					open={true}
					onOpenChange={mockOnOpenChange}
					title="Test Title"
					onConfirm={mockOnConfirm}
					confirmText="Yes, Delete"
					cancelText="No, Keep"
				/>,
			);

			expect(screen.getByText("Yes, Delete")).toBeInTheDocument();
			expect(screen.getByText("No, Keep")).toBeInTheDocument();
		});

		it("uses destructive variant when specified", () => {
			render(
				<ConfirmModal
					open={true}
					onOpenChange={mockOnOpenChange}
					title="Test Title"
					onConfirm={mockOnConfirm}
					variant="destructive"
				/>,
			);

			const confirmButton = screen.getByText("Confirm");
			expect(confirmButton).toHaveAttribute("data-variant", "destructive");
		});

		it("shows loading state on confirm button", () => {
			render(
				<ConfirmModal
					open={true}
					onOpenChange={mockOnOpenChange}
					title="Test Title"
					onConfirm={mockOnConfirm}
					loading={true}
				/>,
			);

			const confirmButton = screen.getByText("Loading...");
			expect(confirmButton).toBeInTheDocument();
			expect(confirmButton).toHaveAttribute("data-loading", "true");
			expect(confirmButton).toBeDisabled();
		});

		it("disables cancel button when loading", () => {
			render(
				<ConfirmModal
					open={true}
					onOpenChange={mockOnOpenChange}
					title="Test Title"
					onConfirm={mockOnConfirm}
					loading={true}
				/>,
			);

			const cancelButton = screen.getByText("Cancel");
			expect(cancelButton).toBeDisabled();
		});
	});

	describe("Button Interactions", () => {
		it("calls onConfirm when confirm button is clicked", () => {
			render(
				<ConfirmModal
					open={true}
					onOpenChange={mockOnOpenChange}
					title="Test Title"
					onConfirm={mockOnConfirm}
				/>,
			);

			const confirmButton = screen.getByText("Confirm");
			fireEvent.click(confirmButton);

			expect(mockOnConfirm).toHaveBeenCalledTimes(1);
		});

		it("calls onCancel and closes modal when cancel button is clicked", () => {
			render(
				<ConfirmModal
					open={true}
					onOpenChange={mockOnOpenChange}
					title="Test Title"
					onConfirm={mockOnConfirm}
					onCancel={mockOnCancel}
				/>,
			);

			const cancelButton = screen.getByText("Cancel");
			fireEvent.click(cancelButton);

			expect(mockOnCancel).toHaveBeenCalledTimes(1);
			expect(mockOnOpenChange).toHaveBeenCalledWith(false);
		});

		it("closes modal when cancel button is clicked without onCancel", () => {
			render(
				<ConfirmModal
					open={true}
					onOpenChange={mockOnOpenChange}
					title="Test Title"
					onConfirm={mockOnConfirm}
				/>,
			);

			const cancelButton = screen.getByText("Cancel");
			fireEvent.click(cancelButton);

			expect(mockOnOpenChange).toHaveBeenCalledWith(false);
		});

		it("does not call onConfirm when confirm button is disabled due to loading", () => {
			render(
				<ConfirmModal
					open={true}
					onOpenChange={mockOnOpenChange}
					title="Test Title"
					onConfirm={mockOnConfirm}
					loading={true}
				/>,
			);

			const confirmButton = screen.getByText("Loading...");
			fireEvent.click(confirmButton);

			expect(mockOnConfirm).not.toHaveBeenCalled();
		});
	});

	describe("Modal Interactions", () => {
		it("calls onOpenChange when modal close button is clicked", () => {
			render(
				<ConfirmModal
					open={true}
					onOpenChange={mockOnOpenChange}
					title="Test Title"
					onConfirm={mockOnConfirm}
				/>,
			);

			const closeButton = screen.getByTestId("modal-close");
			fireEvent.click(closeButton);

			expect(mockOnOpenChange).toHaveBeenCalledWith(false);
		});
	});

	describe("Variants and States", () => {
		it("renders with default variant when not specified", () => {
			render(
				<ConfirmModal
					open={true}
					onOpenChange={mockOnOpenChange}
					title="Test Title"
					onConfirm={mockOnConfirm}
				/>,
			);

			const confirmButton = screen.getByText("Confirm");
			expect(confirmButton).toHaveAttribute("data-variant", "default");
		});

		it("renders with destructive variant", () => {
			render(
				<ConfirmModal
					open={true}
					onOpenChange={mockOnOpenChange}
					title="Delete Item"
					onConfirm={mockOnConfirm}
					variant="destructive"
				/>,
			);

			const confirmButton = screen.getByText("Confirm");
			expect(confirmButton).toHaveAttribute("data-variant", "destructive");
		});

		it("handles loading state correctly", () => {
			render(
				<ConfirmModal
					open={true}
					onOpenChange={mockOnOpenChange}
					title="Test Title"
					onConfirm={mockOnConfirm}
					loading={true}
				/>,
			);

			const confirmButton = screen.getByText("Loading...");
			expect(confirmButton).toHaveAttribute("data-loading", "true");
			expect(confirmButton).toBeDisabled();
		});

		it("handles not loading state correctly", () => {
			render(
				<ConfirmModal
					open={true}
					onOpenChange={mockOnOpenChange}
					title="Test Title"
					onConfirm={mockOnConfirm}
					loading={false}
				/>,
			);

			const confirmButton = screen.getByText("Confirm");
			expect(confirmButton).toHaveAttribute("data-loading", "false");
			expect(confirmButton).not.toBeDisabled();
		});
	});

	describe("Edge Cases", () => {
		it("handles empty title", () => {
			render(
				<ConfirmModal
					open={true}
					onOpenChange={mockOnOpenChange}
					title=""
					onConfirm={mockOnConfirm}
				/>,
			);

			const title = screen.getByTestId("modal-title");
			expect(title).toHaveTextContent("");
		});

		it("handles empty description", () => {
			render(
				<ConfirmModal
					open={true}
					onOpenChange={mockOnOpenChange}
					title="Test Title"
					description=""
					onConfirm={mockOnConfirm}
				/>,
			);

			// Empty description should still render the description element
			const description = screen.getByTestId("modal-description");
			expect(description).toHaveTextContent("");
		});

		it("handles missing onCancel gracefully", () => {
			render(
				<ConfirmModal
					open={true}
					onOpenChange={mockOnOpenChange}
					title="Test Title"
					onConfirm={mockOnConfirm}
				/>,
			);

			const cancelButton = screen.getByText("Cancel");
			fireEvent.click(cancelButton);

			expect(mockOnOpenChange).toHaveBeenCalledWith(false);
		});

		it("handles custom button text with empty strings", () => {
			render(
				<ConfirmModal
					open={true}
					onOpenChange={mockOnOpenChange}
					title="Test Title"
					onConfirm={mockOnConfirm}
					confirmText=""
					cancelText=""
				/>,
			);

			// Empty strings are passed through, resulting in empty buttons
			const footer = screen.getByTestId("modal-footer");
			const buttons = footer.querySelectorAll("button");
			expect(buttons).toHaveLength(2);

			// First button (cancel) has empty text
			expect(buttons[0]).toHaveTextContent("");
			// Second button (confirm) has empty text
			expect(buttons[1]).toHaveTextContent("");
		});
	});

	describe("Default Button Text", () => {
		it("uses default button text when not specified", () => {
			render(
				<ConfirmModal
					open={true}
					onOpenChange={mockOnOpenChange}
					title="Test Title"
					onConfirm={mockOnConfirm}
				/>,
			);

			expect(screen.getByText("Cancel")).toBeInTheDocument();
			expect(screen.getByText("Confirm")).toBeInTheDocument();
		});

		it("does not use default text when custom text is provided", () => {
			render(
				<ConfirmModal
					open={true}
					onOpenChange={mockOnOpenChange}
					title="Test Title"
					onConfirm={mockOnConfirm}
					confirmText="Custom Confirm"
					cancelText="Custom Cancel"
				/>,
			);

			expect(screen.getByText("Custom Confirm")).toBeInTheDocument();
			expect(screen.getByText("Custom Cancel")).toBeInTheDocument();
		});
	});

	describe("Component Structure", () => {
		it("renders modal with correct structure", () => {
			render(
				<ConfirmModal
					open={true}
					onOpenChange={mockOnOpenChange}
					title="Test Title"
					description="Test Description"
					onConfirm={mockOnConfirm}
				/>,
			);

			expect(screen.getByTestId("modal")).toBeInTheDocument();
			expect(screen.getByTestId("modal-title")).toBeInTheDocument();
			expect(screen.getByTestId("modal-description")).toBeInTheDocument();
			expect(screen.getByTestId("modal-content")).toBeInTheDocument();
			expect(screen.getByTestId("modal-footer")).toBeInTheDocument();
		});

		it("renders footer with buttons", () => {
			render(
				<ConfirmModal
					open={true}
					onOpenChange={mockOnOpenChange}
					title="Test Title"
					onConfirm={mockOnConfirm}
				/>,
			);

			const footer = screen.getByTestId("modal-footer");
			expect(footer).toBeInTheDocument();
			expect(footer).toContainElement(screen.getByText("Cancel"));
			expect(footer).toContainElement(screen.getByText("Confirm"));
		});
	});
});
