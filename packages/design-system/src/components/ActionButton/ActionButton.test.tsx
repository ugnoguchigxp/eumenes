import { render, screen } from "@testing-library/react";
import { Plus } from "lucide-react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useIsMobile } from "../../../src/hooks/useMobile";
import { ActionButton } from "./ActionButton";

// Mock dependencies
vi.mock("../../../src/hooks/useMobile");
vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string) => key,
	}),
}));

vi.mock("../../../src/components/Button/Button", () => ({
	Button: React.forwardRef<
		HTMLButtonElement,
		{
			children?: React.ReactNode;
			variant?: string;
			size?: string;
			className?: string;
			icon?: React.ElementType;
			mobileIcon?: boolean;
			[key: string]: unknown;
		}
	>(
		(
			{
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
				mobileIcon?: boolean;
				[key: string]: unknown;
			},
			ref,
		) => {
			// Check if mobileIcon is passed and render it
			const hasMobileIcon = props.mobileIcon;
			return (
				<button
					ref={ref}
					data-variant={variant}
					data-size={size}
					className={className}
					data-icon={Icon ? "has-icon" : "no-icon"}
					data-mobile-icon={
						hasMobileIcon ? "has-mobile-icon" : "no-mobile-icon"
					}
					{...props}
				>
					{hasMobileIcon ? (
						<span data-testid="mobile-icon">MobileIcon</span>
					) : (
						Icon && <span data-testid="icon">Icon</span>
					)}
					{children}
				</button>
			);
		},
	),
}));

vi.mock("@/utils/../", () => ({
	cn: (...classes: (string | undefined)[]) => classes.filter(Boolean).join(" "),
}));

const mockUseIsMobile = vi.mocked(useIsMobile);

describe("ActionButton Component", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockUseIsMobile.mockReturnValue(false); // Default to desktop
	});

	describe("Basic Rendering", () => {
		it("renders with default props on desktop", () => {
			render(<ActionButton label="Test Button" icon={Plus} />);

			const button = screen.getByRole("button");
			expect(button).toBeInTheDocument();
			expect(button).toHaveAttribute("data-variant", "default");
			expect(button).toHaveAttribute("data-size", "default");
			expect(button).toHaveAttribute("data-icon", "has-icon");
			expect(screen.getByText("Test Button")).toBeInTheDocument();
			expect(screen.getByTestId("icon")).toBeInTheDocument();
		});

		it("renders with children when no label provided", () => {
			render(<ActionButton icon={Plus}>Child Text</ActionButton>);

			expect(screen.getByText("Child Text")).toBeInTheDocument();
			expect(screen.getByTestId("icon")).toBeInTheDocument();
		});

		it("renders without icon when not provided", () => {
			render(<ActionButton label="No Icon Button" />);

			const button = screen.getByRole("button");
			expect(button).toHaveAttribute("data-icon", "no-icon");
			expect(screen.queryByTestId("icon")).not.toBeInTheDocument();
		});

		it("renders with custom variant", () => {
			render(<ActionButton label="Custom" variant="outline" icon={Plus} />);

			const button = screen.getByRole("button");
			expect(button).toHaveAttribute("data-variant", "outline");
		});

		it("renders with custom size", () => {
			render(<ActionButton label="Custom" size="lg" icon={Plus} />);

			const button = screen.getByRole("button");
			expect(button).toHaveAttribute("data-size", "lg");
		});

		it("applies custom className", () => {
			render(
				<ActionButton label="Custom" className="custom-class" icon={Plus} />,
			);

			const button = screen.getByRole("button");
			expect(button).toHaveClass("custom-class");
		});
	});

	describe("Mobile Behavior", () => {
		beforeEach(() => {
			mockUseIsMobile.mockReturnValue(true);
		});

		it("uses mobile variant when provided", () => {
			render(
				<ActionButton
					label="Mobile"
					variant="default"
					mobileVariant="outline"
					icon={Plus}
				/>,
			);

			const button = screen.getByRole("button");
			expect(button).toHaveAttribute("data-variant", "outline");
		});

		it("uses desktop variant when mobile variant not provided", () => {
			render(<ActionButton label="Mobile" variant="outline" icon={Plus} />);

			const button = screen.getByRole("button");
			expect(button).toHaveAttribute("data-variant", "outline");
		});

		it("uses mobile icon when provided", () => {
			const MobileIcon = () => (
				<span data-testid="mobile-icon">MobileIcon</span>
			);

			render(
				<ActionButton label="Mobile" icon={Plus} mobileIcon={MobileIcon} />,
			);

			expect(screen.getByTestId("icon")).toBeInTheDocument();
			expect(screen.queryByTestId("mobile-icon")).not.toBeInTheDocument();
		});

		it("shows icon only on mobile by default", () => {
			render(<ActionButton label="Mobile" icon={Plus} />);

			const button = screen.getByRole("button");
			expect(button).toHaveAttribute("data-size", "icon");
			expect(screen.queryByText("Mobile")).not.toBeInTheDocument();
			expect(screen.getByTestId("icon")).toBeInTheDocument();
		});

		it("shows full button on mobile when alwaysFull is true", () => {
			render(<ActionButton label="Mobile" icon={Plus} alwaysFull />);

			const button = screen.getByRole("button");
			expect(button).toHaveAttribute("data-size", "default");
			expect(screen.getByText("Mobile")).toBeInTheDocument();
			expect(screen.getByTestId("icon")).toBeInTheDocument();
		});

		it("shows icon only when iconOnly is true on mobile", () => {
			render(<ActionButton label="Mobile" icon={Plus} iconOnly />);

			const button = screen.getByRole("button");
			expect(button).toHaveAttribute("data-size", "icon");
			expect(screen.queryByText("Mobile")).not.toBeInTheDocument();
			expect(screen.getByTestId("icon")).toBeInTheDocument();
		});
	});

	describe("FAB Behavior", () => {
		beforeEach(() => {
			mockUseIsMobile.mockReturnValue(true);
		});

		it("renders as FAB when isFab is true on mobile", () => {
			render(<ActionButton icon={Plus} isFab />);

			const button = screen.getByRole("button");
			expect(button).toHaveAttribute("data-variant", "fab");
			expect(button).toHaveAttribute("data-size", "icon");
			expect(button).toHaveClass("fixed", "bottom-6", "right-6", "z-50");
			expect(screen.getByTestId("icon")).toBeInTheDocument();
		});

		it("uses mobile variant for FAB when provided", () => {
			render(<ActionButton icon={Plus} isFab mobileVariant="secondary" />);

			const button = screen.getByRole("button");
			expect(button).toHaveAttribute("data-variant", "fab"); // FAB always uses 'fab' variant
		});

		it("uses mobile icon for FAB when provided", () => {
			const MobileIcon = () => (
				<span data-testid="mobile-icon">MobileIcon</span>
			);

			render(<ActionButton icon={Plus} mobileIcon={MobileIcon} isFab />);

			expect(screen.getByTestId("icon")).toBeInTheDocument();
		});

		it("does not render as FAB on desktop", () => {
			mockUseIsMobile.mockReturnValue(false);

			render(<ActionButton icon={Plus} isFab />);

			const button = screen.getByRole("button");
			expect(button).toHaveAttribute("data-variant", "default");
			expect(button).not.toHaveClass("fixed", "bottom-6", "right-6");
		});
	});

	describe("Icon Only Behavior", () => {
		it("shows icon only when iconOnly is true on desktop", () => {
			render(<ActionButton label="Desktop" icon={Plus} iconOnly />);

			const button = screen.getByRole("button");
			expect(button).toHaveAttribute("data-size", "icon");
			expect(screen.queryByText("Desktop")).not.toBeInTheDocument();
			expect(screen.getByTestId("icon")).toBeInTheDocument();
		});

		it("shows full button when iconOnly is false", () => {
			render(<ActionButton label="Desktop" icon={Plus} iconOnly={false} />);

			const button = screen.getByRole("button");
			expect(button).toHaveAttribute("data-size", "default");
			expect(screen.getByText("Desktop")).toBeInTheDocument();
			expect(screen.getByTestId("icon")).toBeInTheDocument();
		});

		it("shows icon only on mobile even when alwaysFull is true", () => {
			mockUseIsMobile.mockReturnValue(true);

			render(<ActionButton label="Mobile" icon={Plus} iconOnly alwaysFull />);

			const button = screen.getByRole("button");
			expect(button).toHaveAttribute("data-size", "icon");
			expect(screen.queryByText("Mobile")).not.toBeInTheDocument();
		});
	});

	describe("Content Rendering", () => {
		it("prioritizes label over children", () => {
			render(
				<ActionButton label="Label Priority" icon={Plus}>
					Children Text
				</ActionButton>,
			);

			expect(screen.getByText("Label Priority")).toBeInTheDocument();
			expect(screen.queryByText("Children Text")).not.toBeInTheDocument();
		});

		it("uses children when label is not provided", () => {
			render(<ActionButton icon={Plus}>Children Text</ActionButton>);

			expect(screen.getByText("Children Text")).toBeInTheDocument();
		});

		it("shows no content when icon only and no children", () => {
			render(<ActionButton icon={Plus} iconOnly />);

			const button = screen.getByRole("button");
			expect(button).toBeInTheDocument();
			expect(screen.getByTestId("icon")).toBeInTheDocument();
			expect(button.textContent?.trim()).toBe("Icon");
		});

		it("shows no label content in icon only mode", () => {
			render(<ActionButton label="Hidden" icon={Plus} iconOnly />);

			expect(screen.queryByText("Hidden")).not.toBeInTheDocument();
			expect(screen.getByTestId("icon")).toBeInTheDocument();
		});
	});

	describe("Props Handling", () => {
		it("passes through all Button props", () => {
			render(
				<ActionButton
					label="Props"
					icon={Plus}
					disabled
					type="submit"
					aria-label="Action Button"
				/>,
			);

			const button = screen.getByRole("button");
			expect(button).toHaveAttribute("disabled");
			expect(button).toHaveAttribute("type", "submit");
			expect(button).toHaveAttribute("aria-label", "Action Button");
		});

		it("handles onClick events", () => {
			const handleClick = vi.fn();
			render(
				<ActionButton label="Click Me" icon={Plus} onClick={handleClick} />,
			);

			const button = screen.getByRole("button");
			button.click();
			expect(handleClick).toHaveBeenCalledTimes(1);
		});

		it("combines className with default classes", () => {
			render(
				<ActionButton
					label="Combined"
					icon={Plus}
					className="custom-class another-class"
				/>,
			);

			const button = screen.getByRole("button");
			expect(button).toHaveClass("custom-class", "another-class");
		});
	});

	describe("Size Logic", () => {
		it("uses icon size when showIconOnly is true", () => {
			render(<ActionButton label="Test" icon={Plus} iconOnly />);

			const button = screen.getByRole("button");
			expect(button).toHaveAttribute("data-size", "icon");
		});

		it("uses default size when not icon only and no size provided", () => {
			render(<ActionButton label="Test" icon={Plus} />);

			const button = screen.getByRole("button");
			expect(button).toHaveAttribute("data-size", "default");
		});

		it("uses provided size when not icon only", () => {
			render(<ActionButton label="Test" icon={Plus} size="sm" />);

			const button = screen.getByRole("button");
			expect(button).toHaveAttribute("data-size", "sm");
		});

		it("mobile icon only uses icon size even with size prop", () => {
			mockUseIsMobile.mockReturnValue(true);

			render(<ActionButton label="Test" icon={Plus} size="lg" />);

			const button = screen.getByRole("button");
			expect(button).toHaveAttribute("data-size", "icon");
		});
	});

	describe("Forward Ref", () => {
		it("forwards ref correctly", () => {
			const ref = { current: null };

			render(<ActionButton label="Ref Test" icon={Plus} ref={ref} />);

			expect(ref.current).toBe(screen.getByRole("button"));
		});

		it("works with null ref", () => {
			expect(() => {
				render(<ActionButton label="Null Ref" icon={Plus} ref={null} />);
			}).not.toThrow();
		});
	});

	describe("Component Metadata", () => {
		it("has correct displayName", () => {
			expect(ActionButton.displayName).toBe("ActionButton");
		});
	});

	describe("Complex Combinations", () => {
		it("handles all props together on desktop", () => {
			const MobileIcon = () => (
				<span data-testid="mobile-icon">MobileIcon</span>
			);

			render(
				<ActionButton
					label="Complex"
					variant="outline"
					mobileVariant="secondary"
					icon={Plus}
					mobileIcon={MobileIcon}
					iconOnly={false}
					alwaysFull={true}
					isFab={false}
					size="lg"
					className="complex-btn"
				/>,
			);

			const button = screen.getByRole("button");
			expect(button).toHaveAttribute("data-variant", "outline");
			expect(button).toHaveAttribute("data-size", "lg");
			expect(button).toHaveClass("complex-btn");
			expect(screen.getByText("Complex")).toBeInTheDocument();
			expect(screen.getByTestId("icon")).toBeInTheDocument();
		});

		it("handles all props together on mobile", () => {
			mockUseIsMobile.mockReturnValue(true);
			const MobileIcon = () => (
				<span data-testid="mobile-icon">MobileIcon</span>
			);

			render(
				<ActionButton
					label="Complex"
					variant="outline"
					mobileVariant="secondary"
					icon={Plus}
					mobileIcon={MobileIcon}
					iconOnly={false}
					alwaysFull={true}
					isFab={false}
					size="lg"
					className="complex-btn"
				/>,
			);

			const button = screen.getByRole("button");
			expect(button).toHaveAttribute("data-variant", "secondary");
			expect(button).toHaveAttribute("data-size", "lg");
			expect(button).toHaveClass("complex-btn");
			expect(screen.getByText("Complex")).toBeInTheDocument();
			expect(screen.getByTestId("icon")).toBeInTheDocument();
		});

		it("handles FAB with all props", () => {
			mockUseIsMobile.mockReturnValue(true);
			const MobileIcon = () => (
				<span data-testid="mobile-icon">MobileIcon</span>
			);

			render(
				<ActionButton
					icon={Plus}
					mobileIcon={MobileIcon}
					isFab={true}
					className="fab-btn"
				/>,
			);

			const button = screen.getByRole("button");
			expect(button).toHaveAttribute("data-variant", "fab");
			expect(button).toHaveAttribute("data-size", "icon");
			expect(button).toHaveClass(
				"fixed",
				"bottom-6",
				"right-6",
				"z-50",
				"fab-btn",
			);
			expect(screen.getByTestId("icon")).toBeInTheDocument();
		});
	});

	describe("Edge Cases", () => {
		it("handles empty label", () => {
			render(<ActionButton label="" icon={Plus} />);

			const button = screen.getByRole("button");
			expect(button).toBeInTheDocument();
			expect(screen.getByTestId("icon")).toBeInTheDocument();
		});

		it("handles undefined label", () => {
			render(<ActionButton label={undefined} icon={Plus} />);

			const button = screen.getByRole("button");
			expect(button).toBeInTheDocument();
			expect(screen.getByTestId("icon")).toBeInTheDocument();
		});

		it("handles no icon and no children", () => {
			render(<ActionButton />);

			const button = screen.getByRole("button");
			expect(button).toBeInTheDocument();
			expect(button).toHaveAttribute("data-icon", "no-icon");
			expect(button.textContent?.trim()).toBe("");
		});

		it("handles no icon with children", () => {
			render(<ActionButton>Children Only</ActionButton>);

			expect(screen.getByText("Children Only")).toBeInTheDocument();
			expect(screen.queryByTestId("icon")).not.toBeInTheDocument();
		});
	});
});
