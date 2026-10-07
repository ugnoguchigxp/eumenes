import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "../../../src/components/Collapsible/Collapsible";

// Mock Radix UI Collapsible
vi.mock("@radix-ui/react-collapsible", () => ({
	Root: ({
		children,
		open,
		onOpenChange,
		...props
	}: {
		children?:
			| React.ReactNode
			| ((props: { open: boolean }) => React.ReactNode);
		open?: boolean;
		onOpenChange?: (open: boolean) => void;
		[key: string]: unknown;
	}) => (
		<div data-testid="collapsible-root" data-open={open} {...props}>
			{typeof children === "function" ? children({ open: !!open }) : children}
		</div>
	),
	CollapsibleTrigger: ({
		children,
		onClick,
		...props
	}: {
		children?: React.ReactNode;
		onClick?: () => void;
		[key: string]: unknown;
	}) => (
		<button data-testid="collapsible-trigger" onClick={onClick} {...props}>
			{children}
		</button>
	),
	CollapsibleContent: ({
		children,
		...props
	}: {
		children?: React.ReactNode;
		[key: string]: unknown;
	}) => (
		<div data-testid="collapsible-content" {...props}>
			{children}
		</div>
	),
}));

describe("Collapsible Components", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe("Collapsible Root", () => {
		it("renders root component", () => {
			render(
				<Collapsible>
					<div>Test Content</div>
				</Collapsible>,
			);

			const root = screen.getByTestId("collapsible-root");
			expect(root).toBeInTheDocument();
			expect(screen.getByText("Test Content")).toBeInTheDocument();
		});

		it("passes through props to root", () => {
			render(
				<Collapsible data-custom="test" className="custom-class">
					<div>Content</div>
				</Collapsible>,
			);

			const root = screen.getByTestId("collapsible-root");
			expect(root).toHaveAttribute("data-custom", "test");
			expect(root).toHaveClass("custom-class");
		});

		it("handles open state", () => {
			render(
				<Collapsible open={true}>
					<div>Open Content</div>
				</Collapsible>,
			);

			const root = screen.getByTestId("collapsible-root");
			expect(root).toHaveAttribute("data-open", "true");
		});

		it("handles closed state", () => {
			render(
				<Collapsible open={false}>
					<div>Closed Content</div>
				</Collapsible>,
			);

			const root = screen.getByTestId("collapsible-root");
			expect(root).toHaveAttribute("data-open", "false");
		});
	});

	describe("CollapsibleTrigger", () => {
		it("renders trigger component", () => {
			render(
				<Collapsible>
					<CollapsibleTrigger>Toggle</CollapsibleTrigger>
				</Collapsible>,
			);

			const trigger = screen.getByTestId("collapsible-trigger");
			expect(trigger).toBeInTheDocument();
			expect(trigger).toHaveTextContent("Toggle");
			expect(trigger.tagName).toBe("BUTTON");
		});

		it("passes through props to trigger", () => {
			render(
				<Collapsible>
					<CollapsibleTrigger
						data-custom="trigger"
						className="trigger-class"
						disabled
					>
						Custom Trigger
					</CollapsibleTrigger>
				</Collapsible>,
			);

			const trigger = screen.getByTestId("collapsible-trigger");
			expect(trigger).toHaveAttribute("data-custom", "trigger");
			expect(trigger).toHaveClass("trigger-class");
			expect(trigger).toBeDisabled();
		});

		it("handles click events", () => {
			const handleClick = vi.fn();

			render(
				<Collapsible>
					<CollapsibleTrigger onClick={handleClick}>
						Click Me
					</CollapsibleTrigger>
				</Collapsible>,
			);

			const trigger = screen.getByTestId("collapsible-trigger");
			fireEvent.click(trigger);

			expect(handleClick).toHaveBeenCalledTimes(1);
		});

		it("renders complex content as children", () => {
			render(
				<Collapsible>
					<CollapsibleTrigger>
						<span>Icon</span>
						<span>Text</span>
					</CollapsibleTrigger>
				</Collapsible>,
			);

			expect(screen.getByText("Icon")).toBeInTheDocument();
			expect(screen.getByText("Text")).toBeInTheDocument();
		});
	});

	describe("CollapsibleContent", () => {
		it("renders content component", () => {
			render(
				<Collapsible>
					<CollapsibleContent>Content Area</CollapsibleContent>
				</Collapsible>,
			);

			const content = screen.getByTestId("collapsible-content");
			expect(content).toBeInTheDocument();
			expect(content).toHaveTextContent("Content Area");
			expect(content.tagName).toBe("DIV");
		});

		it("passes through props to content", () => {
			render(
				<Collapsible>
					<CollapsibleContent
						data-custom="content"
						className="content-class"
						role="region"
					>
						Custom Content
					</CollapsibleContent>
				</Collapsible>,
			);

			const content = screen.getByTestId("collapsible-content");
			expect(content).toHaveAttribute("data-custom", "content");
			expect(content).toHaveClass("content-class");
			expect(content).toHaveAttribute("role", "region");
		});

		it("renders complex content", () => {
			render(
				<Collapsible>
					<CollapsibleContent>
						<p>Paragraph 1</p>
						<p>Paragraph 2</p>
						<button type="button">Action</button>
					</CollapsibleContent>
				</Collapsible>,
			);

			expect(screen.getByText("Paragraph 1")).toBeInTheDocument();
			expect(screen.getByText("Paragraph 2")).toBeInTheDocument();
			expect(screen.getByText("Action")).toBeInTheDocument();
		});

		it("handles empty content", () => {
			render(
				<Collapsible>
					<CollapsibleContent />
				</Collapsible>,
			);

			const content = screen.getByTestId("collapsible-content");
			expect(content).toBeInTheDocument();
			expect(content).toBeEmptyDOMElement();
		});
	});

	describe("Complete Collapsible Structure", () => {
		it("renders all components together", () => {
			render(
				<Collapsible>
					<CollapsibleTrigger>Toggle Section</CollapsibleTrigger>
					<CollapsibleContent>
						<p>This is collapsible content</p>
					</CollapsibleContent>
				</Collapsible>,
			);

			expect(screen.getByTestId("collapsible-root")).toBeInTheDocument();
			expect(screen.getByTestId("collapsible-trigger")).toBeInTheDocument();
			expect(screen.getByTestId("collapsible-content")).toBeInTheDocument();
			expect(screen.getByText("Toggle Section")).toBeInTheDocument();
			expect(
				screen.getByText("This is collapsible content"),
			).toBeInTheDocument();
		});

		it("maintains proper component hierarchy", () => {
			render(
				<Collapsible data-testid="main-collapsible">
					<CollapsibleTrigger data-testid="trigger">Trigger</CollapsibleTrigger>
					<CollapsibleContent data-testid="content">Content</CollapsibleContent>
				</Collapsible>,
			);

			const root = screen.getByTestId("main-collapsible");
			const trigger = screen.getByTestId("trigger");
			const content = screen.getByTestId("content");

			expect(root).toContainElement(trigger);
			expect(root).toContainElement(content);
		});

		it("handles multiple collapsible instances", () => {
			render(
				<div>
					<Collapsible data-testid="collapsible-1">
						<CollapsibleTrigger>First</CollapsibleTrigger>
						<CollapsibleContent>First Content</CollapsibleContent>
					</Collapsible>
					<Collapsible data-testid="collapsible-2">
						<CollapsibleTrigger>Second</CollapsibleTrigger>
						<CollapsibleContent>Second Content</CollapsibleContent>
					</Collapsible>
				</div>,
			);

			expect(screen.getByTestId("collapsible-1")).toBeInTheDocument();
			expect(screen.getByTestId("collapsible-2")).toBeInTheDocument();
			expect(screen.getByText("First")).toBeInTheDocument();
			expect(screen.getByText("Second")).toBeInTheDocument();
			expect(screen.getByText("First Content")).toBeInTheDocument();
			expect(screen.getByText("Second Content")).toBeInTheDocument();
		});
	});

	describe("Component Behavior", () => {
		it("handles dynamic content changes", () => {
			const { rerender } = render(
				<Collapsible>
					<CollapsibleContent>Initial Content</CollapsibleContent>
				</Collapsible>,
			);

			expect(screen.getByText("Initial Content")).toBeInTheDocument();

			rerender(
				<Collapsible>
					<CollapsibleContent>Updated Content</CollapsibleContent>
				</Collapsible>,
			);

			expect(screen.getByText("Updated Content")).toBeInTheDocument();
			expect(screen.queryByText("Initial Content")).not.toBeInTheDocument();
		});

		it("handles conditional rendering", () => {
			const { rerender } = render(
				<Collapsible>
					<CollapsibleContent>Always Visible</CollapsibleContent>
				</Collapsible>,
			);

			expect(screen.getByText("Always Visible")).toBeInTheDocument();

			rerender(
				<Collapsible>
					{false && <CollapsibleContent>Hidden Content</CollapsibleContent>}
				</Collapsible>,
			);

			expect(screen.queryByText("Hidden Content")).not.toBeInTheDocument();
		});

		it("handles nested components", () => {
			render(
				<Collapsible>
					<CollapsibleTrigger>
						<div>
							<span>Nested Icon</span>
							<span>Nested Text</span>
						</div>
					</CollapsibleTrigger>
					<CollapsibleContent>
						<div>
							<p>Nested Content</p>
							<div>
								<button type="button">Nested Button</button>
							</div>
						</div>
					</CollapsibleContent>
				</Collapsible>,
			);

			expect(screen.getByText("Nested Icon")).toBeInTheDocument();
			expect(screen.getByText("Nested Text")).toBeInTheDocument();
			expect(screen.getByText("Nested Content")).toBeInTheDocument();
			expect(screen.getByText("Nested Button")).toBeInTheDocument();
		});
	});

	describe("Accessibility", () => {
		it("supports accessibility attributes", () => {
			render(
				<Collapsible>
					<CollapsibleTrigger
						aria-expanded="false"
						aria-controls="content-panel"
					>
						Accessible Trigger
					</CollapsibleTrigger>
					<CollapsibleContent
						id="content-panel"
						role="region"
						aria-labelledby="trigger-button"
					>
						Accessible Content
					</CollapsibleContent>
				</Collapsible>,
			);

			const trigger = screen.getByTestId("collapsible-trigger");
			const content = screen.getByTestId("collapsible-content");

			expect(trigger).toHaveAttribute("aria-expanded", "false");
			expect(trigger).toHaveAttribute("aria-controls", "content-panel");
			expect(content).toHaveAttribute("id", "content-panel");
			expect(content).toHaveAttribute("role", "region");
			expect(content).toHaveAttribute("aria-labelledby", "trigger-button");
		});

		it("supports keyboard navigation", () => {
			render(
				<Collapsible>
					<CollapsibleTrigger tabIndex={0}>Keyboard Trigger</CollapsibleTrigger>
				</Collapsible>,
			);

			const trigger = screen.getByTestId("collapsible-trigger");
			expect(trigger).toHaveAttribute("tabIndex", "0");

			trigger.focus();
			expect(document.activeElement).toBe(trigger);
		});
	});

	describe("Error Handling", () => {
		it("handles missing children gracefully", () => {
			expect(() => {
				render(<Collapsible />);
			}).not.toThrow();
		});

		it("handles undefined props gracefully", () => {
			expect(() => {
				render(
					<Collapsible className={undefined} data-custom={undefined}>
						<CollapsibleTrigger>Test</CollapsibleTrigger>
					</Collapsible>,
				);
			}).not.toThrow();
		});

		it("handles null children", () => {
			render(
				<Collapsible>
					{null}
					<CollapsibleTrigger>Valid Child</CollapsibleTrigger>
					{null}
				</Collapsible>,
			);

			expect(screen.getByText("Valid Child")).toBeInTheDocument();
		});
	});

	describe("Component Exports", () => {
		it("exports all components correctly", () => {
			expect(Collapsible).toBeDefined();
			expect(CollapsibleTrigger).toBeDefined();
			expect(CollapsibleContent).toBeDefined();

			expect(typeof Collapsible).toBe("function");
			expect(typeof CollapsibleTrigger).toBe("function");
			expect(typeof CollapsibleContent).toBe("function");
		});

		it("components are renderable", () => {
			expect(() => {
				render(
					<div>
						<Collapsible />
						<CollapsibleTrigger />
						<CollapsibleContent />
					</div>,
				);
			}).not.toThrow();
		});
	});

	describe("Integration with Radix UI", () => {
		it("maintains Radix UI component structure", () => {
			render(
				<Collapsible>
					<CollapsibleTrigger>Radix Trigger</CollapsibleTrigger>
					<CollapsibleContent>Radix Content</CollapsibleContent>
				</Collapsible>,
			);

			// Should render with proper test IDs from our mock
			expect(screen.getByTestId("collapsible-root")).toBeInTheDocument();
			expect(screen.getByTestId("collapsible-trigger")).toBeInTheDocument();
			expect(screen.getByTestId("collapsible-content")).toBeInTheDocument();
		});

		it("handles Radix UI specific props", () => {
			render(
				<Collapsible defaultOpen={true} disabled={false}>
					<CollapsibleTrigger asChild>
						<div>Custom Trigger Element</div>
					</CollapsibleTrigger>
					<CollapsibleContent forceMount>
						Force Mounted Content
					</CollapsibleContent>
				</Collapsible>,
			);

			expect(screen.getByText("Custom Trigger Element")).toBeInTheDocument();
			expect(screen.getByText("Force Mounted Content")).toBeInTheDocument();
		});
	});
});
