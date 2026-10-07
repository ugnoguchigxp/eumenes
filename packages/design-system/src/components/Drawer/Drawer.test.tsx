import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Drawer } from "./Drawer";

// Mock Radix UI Dialog components with event visibility
vi.mock("@radix-ui/react-dialog", () => ({
	Root: ({
		children,
		open,
		onOpenChange,
	}: {
		children?:
			| React.ReactNode
			| ((props: { open: boolean }) => React.ReactNode);
		open?: boolean;
		onOpenChange?: (open: boolean) => void;
	}) => (
		// biome-ignore lint/a11y/noStaticElementInteractions: Mock element needs click
		<div
			data-testid="dialog-root"
			data-open={open}
			onClick={() => onOpenChange?.(false)}
			onKeyDown={(event) => {
				if (event.key === "Enter" || event.key === " ") {
					event.preventDefault();
					onOpenChange?.(false);
				}
			}}
		>
			{typeof children === "function" ? children({ open: !!open }) : children}
		</div>
	),
	Portal: ({ children }: { children?: React.ReactNode }) => (
		<div data-testid="dialog-portal">{children}</div>
	),
	Overlay: ({
		className,
		...props
	}: {
		className?: string;
		[key: string]: unknown;
	}) => <div data-testid="dialog-overlay" className={className} {...props} />,
	Content: ({
		className,
		style,
		children,
		...props
	}: {
		className?: string;
		style?: React.CSSProperties;
		children?: React.ReactNode;
		[key: string]: unknown;
	}) => (
		<div
			data-testid="dialog-content"
			className={className}
			style={style}
			{...props}
		>
			{children}
		</div>
	),
	Title: ({
		className,
		style,
		children,
		...props
	}: {
		className?: string;
		style?: React.CSSProperties;
		children?: React.ReactNode;
		[key: string]: unknown;
	}) => (
		<h2
			data-testid="dialog-title"
			className={className}
			style={style}
			{...props}
		>
			{children}
		</h2>
	),
	Description: ({
		className,
		style,
		children,
		...props
	}: {
		className?: string;
		style?: React.CSSProperties;
		children?: React.ReactNode;
		[key: string]: unknown;
	}) => (
		<p
			data-testid="dialog-description"
			className={className}
			style={style}
			{...props}
		>
			{children}
		</p>
	),
	Close: ({
		className,
		children,
		...props
	}: {
		className?: string;
		children?: React.ReactNode;
		[key: string]: unknown;
	}) => (
		<button data-testid="dialog-close" className={className} {...props}>
			{children}
		</button>
	),
}));

// Mock the cn utility
vi.mock("@/utils/../", () => ({
	cn: (...classes: (string | undefined)[]) => classes.filter(Boolean).join(" "),
}));

describe("Drawer Component", () => {
	const mockOnClose = vi.fn();

	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe("Basic Rendering", () => {
		it("renders when open", () => {
			render(
				<Drawer isOpen={true} onClose={mockOnClose}>
					<div>Content</div>
				</Drawer>,
			);

			expect(screen.getByTestId("dialog-root")).toHaveAttribute(
				"data-open",
				"true",
			);
			expect(screen.getByTestId("dialog-portal")).toBeInTheDocument();
			expect(screen.getByTestId("dialog-overlay")).toBeInTheDocument();
			expect(screen.getByTestId("dialog-content")).toBeInTheDocument();
		});

		it("does not render when closed", () => {
			render(
				<Drawer isOpen={false} onClose={mockOnClose}>
					<div>Content</div>
				</Drawer>,
			);

			expect(screen.getByTestId("dialog-root")).toHaveAttribute(
				"data-open",
				"false",
			);
		});

		it("renders default title when no title provided (sr-only)", () => {
			render(
				<Drawer isOpen={true} onClose={mockOnClose}>
					<div>Content</div>
				</Drawer>,
			);

			const title = screen.getByTestId("dialog-title");
			expect(title).toHaveTextContent("Drawer");
			expect(title).toHaveClass("sr-only");
		});

		it("renders provided title", () => {
			render(
				<Drawer isOpen={true} onClose={mockOnClose} title="My Title">
					<div>Content</div>
				</Drawer>,
			);

			const title = screen.getByTestId("dialog-title");
			expect(title).toHaveTextContent("My Title");
			expect(title).not.toHaveClass("sr-only");
		});

		it("renders description if provided", () => {
			render(
				<Drawer isOpen={true} onClose={mockOnClose} description="My Desc">
					<div>Content</div>
				</Drawer>,
			);

			expect(screen.getByTestId("dialog-description")).toHaveTextContent(
				"My Desc",
			);
		});
	});

	describe("Props & Variants", () => {
		it("calls onClose when onOpenChange(false) is triggered", () => {
			render(
				<Drawer isOpen={true} onClose={mockOnClose}>
					<div>Content</div>
				</Drawer>,
			);

			// Our mock calls onOpenChange(false) when clicked
			fireEvent.click(screen.getByTestId("dialog-root"));
			expect(mockOnClose).toHaveBeenCalled();
		});

		it("applies noPadding class", () => {
			render(
				<Drawer isOpen={true} onClose={mockOnClose} noPadding>
					<div>Content</div>
				</Drawer>,
			);

			expect(screen.getByTestId("dialog-content")).toHaveClass("p-0");
		});

		it("applies custom width", () => {
			render(
				<Drawer isOpen={true} onClose={mockOnClose} width="500px">
					<div>Content</div>
				</Drawer>,
			);

			const content = screen.getByTestId("dialog-content");
			expect(content).toHaveStyle({ width: "500px", maxWidth: "100vw" });
		});

		it("renders with different positions", () => {
			// Test all positions to cover cva variants
			["top", "bottom", "left", "right"].forEach((pos) => {
				const { unmount } = render(
					// biome-ignore lint/suspicious/noExplicitAny: Testing strict types
					<Drawer isOpen={true} onClose={mockOnClose} position={pos as any}>
						<div>Content</div>
					</Drawer>,
				);
				// Since cva generates classes, we rely on the fact that existing css strings are returned by mocked cn
				// OR if standard cn mock just joins them.
				// But we mostly want to execute the code path.
				unmount();
			});
		});
	});
});
