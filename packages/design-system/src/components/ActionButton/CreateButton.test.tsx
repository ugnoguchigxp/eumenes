import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CreateButton } from "../../../src/components/ActionButton/CreateButton";

// Mock dependencies
vi.mock("@/hooks/useMobile", () => ({
	useIsMobile: () => false, // Default to desktop
}));

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string) => key,
	}),
}));

vi.mock("@/components/Button", () => ({
	Button: ({
		children,
		variant,
		size,
		className,
		icon: Icon,
		...props
	}: {
		children?: React.ReactNode;
		variant?: string;
		size?: string;
		className?: string;
		icon?: React.ElementType;
		[key: string]: unknown;
	}) => (
		<button
			data-variant={variant}
			data-size={size}
			className={className}
			data-icon={Icon ? "has-icon" : "no-icon"}
			{...props}
		>
			{Icon && <span data-testid="icon">Icon</span>}
			{children}
		</button>
	),
}));

vi.mock("@/utils/../", () => ({
	cn: (...classes: (string | undefined)[]) => classes.filter(Boolean).join(" "),
}));

describe("CreateButton Component", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe("Basic Rendering", () => {
		it("renders with default props", () => {
			render(<CreateButton />);

			const button = screen.getByRole("button");
			expect(button).toBeInTheDocument();
			expect(button).toHaveAttribute("data-variant", "default");
			expect(button).toHaveTextContent("Create New");
		});

		it("renders with custom label", () => {
			render(<CreateButton label="Add New Item" />);

			const button = screen.getByRole("button");
			expect(button).toHaveTextContent("Add New Item");
		});

		it("renders with custom variant", () => {
			render(<CreateButton variant="destructive" />);

			const button = screen.getByRole("button");
			expect(button).toHaveAttribute("data-variant", "destructive");
		});

		it("renders with custom className", () => {
			render(<CreateButton className="custom-create-btn" />);

			const button = screen.getByRole("button");
			expect(button).toHaveClass("custom-create-btn");
		});

		it("renders icon by default", () => {
			render(<CreateButton />);

			const icon = screen.getByTestId("icon");
			expect(icon).toBeInTheDocument();
			expect(icon).toHaveTextContent("Icon");
		});

		it("renders as button element", () => {
			render(<CreateButton />);

			const button = screen.getByRole("button");
			expect(button.tagName).toBe("BUTTON");
		});
	});

	describe("Position Variants", () => {
		it("renders inline by default", () => {
			render(<CreateButton />);

			const button = screen.getByRole("button");
			expect(button).not.toHaveClass("fixed", "bottom-6", "right-6");
		});

		it("renders inline when position is inline", () => {
			render(<CreateButton position="inline" />);

			const button = screen.getByRole("button");
			expect(button).not.toHaveClass("fixed", "bottom-6", "right-6");
		});

		it("renders as FAB when position is fab", () => {
			render(<CreateButton position="fab" />);

			const button = screen.getByRole("button");
			expect(button).toBeInTheDocument();
			// FAB behavior depends on mobile detection, just check it renders
		});
	});

	describe("Icon Handling", () => {
		it("renders with default Plus icon", () => {
			render(<CreateButton />);

			const button = screen.getByRole("button");
			expect(button).toHaveAttribute("data-icon", "has-icon");
		});

		it("renders with custom icon", () => {
			const CustomIcon = () => <span data-testid="custom-icon">Custom</span>;

			render(<CreateButton icon={CustomIcon} />);

			const button = screen.getByRole("button");
			expect(button).toHaveAttribute("data-icon", "has-icon");
		});

		it("renders without icon when icon is null", () => {
			render(<CreateButton icon={null as unknown as React.ElementType} />);

			const button = screen.getByRole("button");
			expect(button).toHaveAttribute("data-icon", "no-icon");
			expect(screen.queryByTestId("icon")).not.toBeInTheDocument();
		});
	});

	describe("Size and Layout", () => {
		it("uses default size", () => {
			render(<CreateButton />);

			const button = screen.getByRole("button");
			expect(button).toHaveAttribute("data-size", "default");
		});

		it("uses custom size", () => {
			render(<CreateButton size="sm" />);

			const button = screen.getByRole("button");
			expect(button).toHaveAttribute("data-size", "sm");
		});

		it("uses icon size when iconOnly", () => {
			render(<CreateButton iconOnly />);

			const button = screen.getByRole("button");
			expect(button).toHaveAttribute("data-size", "icon");
		});
	});

	describe("Accessibility", () => {
		it("preserves accessibility attributes", () => {
			render(<CreateButton aria-label="Create new item" disabled />);

			const button = screen.getByRole("button");
			expect(button).toHaveAttribute("aria-label", "Create new item");
			expect(button).toBeDisabled();
		});

		it("handles click events", () => {
			const handleClick = vi.fn();
			render(<CreateButton onClick={handleClick} />);

			const button = screen.getByRole("button");
			button.click();

			expect(handleClick).toHaveBeenCalledTimes(1);
		});
	});

	describe("Component Properties", () => {
		it("passes through additional props", () => {
			render(
				<CreateButton
					data-testid="create-button-test"
					title="Create new item"
				/>,
			);

			const button = screen.getByTestId("create-button-test");
			expect(button).toBeInTheDocument();
			expect(button).toHaveAttribute("title", "Create new item");
		});

		it("merges className with default classes", () => {
			render(<CreateButton className="custom-class another-class" />);

			const button = screen.getByRole("button");
			expect(button).toHaveClass("custom-class", "another-class");
		});
	});

	describe("Internationalization", () => {
		it("uses default label when label is not provided", () => {
			render(<CreateButton />);

			const button = screen.getByRole("button");
			expect(button).toHaveTextContent("Create New");
		});

		it("overrides default label with custom label", () => {
			render(<CreateButton label="Custom Create" />);

			const button = screen.getByRole("button");
			expect(button).toHaveTextContent("Custom Create");
			expect(button).not.toHaveTextContent("Create New");
		});
	});

	describe("Edge Cases", () => {
		it("handles empty label", () => {
			render(<CreateButton label="" />);

			const button = screen.getByRole("button");
			expect(button).toBeInTheDocument();
			// Empty label still shows icon
			expect(screen.getByTestId("icon")).toBeInTheDocument();
		});

		it("prioritizes label over children", () => {
			render(
				<CreateButton label="Priority Label">
					<span>Child Content</span>
				</CreateButton>,
			);

			const button = screen.getByRole("button");
			expect(button).toHaveTextContent("Priority Label");
			expect(button).not.toHaveTextContent("Child Content");
		});
	});

	describe("Display Name", () => {
		it("has correct display name", () => {
			expect(CreateButton.displayName).toBe("CreateButton");
		});
	});

	describe("FAB Behavior", () => {
		it("renders FAB variant when position is fab", () => {
			render(<CreateButton position="fab" />);

			const button = screen.getByRole("button");
			expect(button).toBeInTheDocument();
		});

		it("applies custom className to FAB", () => {
			render(<CreateButton position="fab" className="custom-fab" />);

			const button = screen.getByRole("button");
			expect(button).toHaveClass("custom-fab");
		});
	});
});
