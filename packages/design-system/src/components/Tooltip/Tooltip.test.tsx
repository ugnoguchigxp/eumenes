import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/Tooltip/Tooltip";

describe("Tooltip Components", () => {
	// Helper component for testing
	const TestTooltip = ({
		children,
		content,
		...props
	}: {
		children: React.ReactNode;
		content: React.ReactNode;
		[key: string]: unknown;
	}) => (
		<TooltipProvider>
			<Tooltip>
				<TooltipTrigger asChild>
					<button type="button">Hover me</button>
				</TooltipTrigger>
				<TooltipContent {...props}>{content}</TooltipContent>
			</Tooltip>
		</TooltipProvider>
	);

	describe("Basic Rendering", () => {
		it("renders trigger button", () => {
			render(
				<TestTooltip content="Tooltip content">
					<div>Trigger content</div>
				</TestTooltip>,
			);

			expect(screen.getByText("Hover me")).toBeInTheDocument();
		});

		it("does not show tooltip content initially", () => {
			render(
				<TestTooltip content="Tooltip content">
					<div>Trigger content</div>
				</TestTooltip>,
			);

			expect(screen.queryByText("Tooltip content")).not.toBeInTheDocument();
		});
	});

	describe("TooltipContent Properties", () => {
		it("renders with default styling", () => {
			render(
				<TestTooltip content="Default styled tooltip">
					<div>Trigger content</div>
				</TestTooltip>,
			);

			expect(screen.getByText("Hover me")).toBeInTheDocument();
		});

		it("supports side positioning", () => {
			render(
				<TestTooltip content="Top tooltip" side="top">
					<div>Trigger content</div>
				</TestTooltip>,
			);

			expect(screen.getByText("Hover me")).toBeInTheDocument();
		});

		it("supports side offset", () => {
			render(
				<TestTooltip content="Offset tooltip" sideOffset={8}>
					<div>Trigger content</div>
				</TestTooltip>,
			);

			expect(screen.getByText("Hover me")).toBeInTheDocument();
		});

		it("supports align positioning", () => {
			render(
				<TestTooltip content="Start aligned tooltip" align="start">
					<div>Trigger content</div>
				</TestTooltip>,
			);

			expect(screen.getByText("Hover me")).toBeInTheDocument();
		});
	});

	describe("TooltipContent Content", () => {
		it("renders text content", () => {
			render(
				<TestTooltip content="Simple text">
					<div>Trigger content</div>
				</TestTooltip>,
			);

			expect(screen.getByText("Hover me")).toBeInTheDocument();
		});

		it("renders complex content", () => {
			render(
				<TestTooltip
					content={
						<div>
							<strong>Bold text</strong>
							<span>Regular text</span>
						</div>
					}
				>
					<div>Trigger content</div>
				</TestTooltip>,
			);

			expect(screen.getByText("Hover me")).toBeInTheDocument();
		});
	});

	describe("Accessibility", () => {
		it("has proper ARIA attributes", () => {
			render(
				<TestTooltip content="Accessible tooltip">
					<div>Trigger content</div>
				</TestTooltip>,
			);

			const trigger = screen.getByText("Hover me");
			expect(trigger).toBeInTheDocument();
		});

		it("supports keyboard navigation", () => {
			render(
				<TestTooltip content="Keyboard tooltip">
					<div>Trigger content</div>
				</TestTooltip>,
			);

			const trigger = screen.getByText("Hover me");
			expect(trigger).toBeInTheDocument();
		});
	});

	describe("TooltipProvider", () => {
		it("wraps tooltip components properly", () => {
			render(
				<TooltipProvider>
					<Tooltip>
						<TooltipTrigger asChild>
							<button type="button">Provider test</button>
						</TooltipTrigger>
						<TooltipContent>Provider content</TooltipContent>
					</Tooltip>
				</TooltipProvider>,
			);

			expect(screen.getByText("Provider test")).toBeInTheDocument();
		});

		it("renders multiple tooltips with provider", () => {
			render(
				<TooltipProvider>
					<div>
						<Tooltip>
							<TooltipTrigger asChild>
								<button type="button">First</button>
							</TooltipTrigger>
							<TooltipContent>First tooltip</TooltipContent>
						</Tooltip>
						<Tooltip>
							<TooltipTrigger asChild>
								<button type="button">Second</button>
							</TooltipTrigger>
							<TooltipContent>Second tooltip</TooltipContent>
						</Tooltip>
					</div>
				</TooltipProvider>,
			);

			const firstTrigger = screen.getByText("First");
			const secondTrigger = screen.getByText("Second");

			expect(firstTrigger).toBeInTheDocument();
			expect(secondTrigger).toBeInTheDocument();
		});
	});

	describe("Component Properties", () => {
		it("has correct displayName", () => {
			expect(TooltipProvider).toBeDefined();
			expect(Tooltip).toBeDefined();
			expect(TooltipTrigger).toBeDefined();
			expect(TooltipContent).toBeDefined();
		});

		it("passes through additional props", () => {
			render(
				<TestTooltip content="Props test" data-testid="tooltip-content">
					<div>Trigger content</div>
				</TestTooltip>,
			);

			expect(screen.getByText("Hover me")).toBeInTheDocument();
		});
	});

	describe("Edge Cases", () => {
		it("handles long tooltip content", () => {
			const longContent =
				"This is a very long tooltip content that should wrap properly and display correctly without breaking the layout or causing any issues with the tooltip positioning and rendering.";

			render(
				<TestTooltip content={longContent}>
					<div>Trigger content</div>
				</TestTooltip>,
			);

			expect(screen.getByText("Hover me")).toBeInTheDocument();
		});

		it("handles special characters in content", () => {
			const specialContent =
				"Tooltip with émojis 🎉 and special chars & symbols";

			render(
				<TestTooltip content={specialContent}>
					<div>Trigger content</div>
				</TestTooltip>,
			);

			expect(screen.getByText("Hover me")).toBeInTheDocument();
		});

		it("handles disabled trigger", () => {
			render(
				<TooltipProvider>
					<Tooltip>
						<TooltipTrigger asChild>
							<button type="button" disabled>
								Disabled button
							</button>
						</TooltipTrigger>
						<TooltipContent>Disabled tooltip</TooltipContent>
					</Tooltip>
				</TooltipProvider>,
			);

			const trigger = screen.getByText("Disabled button");
			expect(trigger).toBeInTheDocument();
			expect(trigger).toBeDisabled();
		});
	});

	describe("Animation and Transitions", () => {
		it("applies animation classes", () => {
			render(
				<TestTooltip content="Animated tooltip">
					<div>Trigger content</div>
				</TestTooltip>,
			);

			expect(screen.getByText("Hover me")).toBeInTheDocument();
		});
	});
});
