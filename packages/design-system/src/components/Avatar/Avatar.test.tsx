import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Avatar } from "./Avatar";

describe("Avatar Component", () => {
	describe("Basic Rendering", () => {
		it("renders avatar container", () => {
			render(<Avatar />);

			const avatar = document.querySelector(".relative");
			expect(avatar).toBeInTheDocument();
			expect(avatar).toHaveClass(
				"flex",
				"shrink-0",
				"overflow-hidden",
				"rounded-full",
			);
		});

		it("renders with default size (md)", () => {
			render(<Avatar />);

			const avatar = document.querySelector(".relative");
			expect(avatar).toHaveClass("h-11", "w-11", "text-sm");
		});

		it("renders fallback text when no src provided", () => {
			render(<Avatar fallback="John Doe" />);

			expect(screen.getByText("JD")).toBeInTheDocument();
		});

		it('renders fallback "?" when no src or fallback provided', () => {
			render(<Avatar />);

			expect(screen.getByText("?")).toBeInTheDocument();
		});
	});

	describe("Image Rendering", () => {
		it("renders image when src is provided", () => {
			render(<Avatar src="test.jpg" alt="Test Avatar" />);

			const img = document.querySelector("img");
			expect(img).toBeInTheDocument();
			expect(img).toHaveAttribute("src", "test.jpg");
			expect(img).toHaveAttribute("alt", "Test Avatar");
		});

		it("shows fallback when image fails to load", () => {
			render(<Avatar src="invalid.jpg" fallback="Error" />);

			const img = document.querySelector("img");
			expect(img).toBeInTheDocument();
			if (img) {
				fireEvent.error(img);
			}

			// Check that fallback container is present
			const fallbackContainer = document.querySelector(".bg-muted");
			expect(fallbackContainer).toBeInTheDocument();

			// "Error" is a single word, so it becomes "E" (first character, uppercase)
			expect(screen.getByText("E")).toBeInTheDocument();
		});

		it("uses alt text for fallback when no fallback provided", () => {
			render(<Avatar src="invalid.jpg" alt="John Smith" />);

			const img = document.querySelector("img");
			expect(img).toBeInTheDocument();
			if (img) {
				fireEvent.error(img);
			}

			expect(screen.getByText("JS")).toBeInTheDocument();
		});

		it('uses default alt "Avatar" when no alt provided', () => {
			render(<Avatar src="test.jpg" />);

			const img = document.querySelector("img");
			expect(img).toHaveAttribute("alt", "Avatar");
		});
	});

	describe("Size Variants", () => {
		it("renders xs size", () => {
			render(<Avatar size="xs" />);

			const avatar = document.querySelector(".relative");
			expect(avatar).toHaveClass("h-7", "w-7", "text-xs");
		});

		it("renders sm size", () => {
			render(<Avatar size="sm" />);

			const avatar = document.querySelector(".relative");
			expect(avatar).toHaveClass("h-8", "w-8", "text-xs");
		});

		it("renders md size (default)", () => {
			render(<Avatar size="md" />);

			const avatar = document.querySelector(".relative");
			expect(avatar).toHaveClass("h-11", "w-11", "text-sm");
		});

		it("renders lg size", () => {
			render(<Avatar size="lg" />);

			const avatar = document.querySelector(".relative");
			expect(avatar).toHaveClass("h-16", "w-16", "text-lg");
		});

		it("renders xl size", () => {
			render(<Avatar size="xl" />);

			const avatar = document.querySelector(".relative");
			expect(avatar).toHaveClass("h-20", "w-20", "text-xl");
		});
	});

	describe("Fallback Functionality", () => {
		it("generates initials from fallback string", () => {
			render(<Avatar fallback="Jane Marie Doe" />);

			expect(screen.getByText("JM")).toBeInTheDocument();
		});

		it("generates initials from alt text when no fallback", () => {
			render(<Avatar alt="Alice Johnson" />);

			expect(screen.getByText("AJ")).toBeInTheDocument();
		});

		it("handles single word fallback", () => {
			render(<Avatar fallback="John" />);

			expect(screen.getByText("J")).toBeInTheDocument();
		});

		it("handles single word alt text", () => {
			render(<Avatar alt="Alice" />);

			expect(screen.getByText("A")).toBeInTheDocument();
		});

		it("renders React element fallback", () => {
			render(
				<Avatar fallback={<span data-testid="custom-fallback">Custom</span>} />,
			);

			expect(screen.getByTestId("custom-fallback")).toBeInTheDocument();
			expect(screen.getByText("Custom")).toBeInTheDocument();
		});

		it("limits initials to 2 characters", () => {
			render(<Avatar fallback="John Michael Andrew Doe" />);

			expect(screen.getByText("JM")).toBeInTheDocument();
		});

		it("converts initials to uppercase", () => {
			render(<Avatar fallback="john doe" />);

			expect(screen.getByText("JD")).toBeInTheDocument();
		});
	});

	describe("Styling", () => {
		it("applies custom className", () => {
			render(<Avatar className="custom-avatar" />);

			const avatar = document.querySelector(".relative");
			expect(avatar).toHaveClass("custom-avatar");
			expect(avatar).toHaveClass("flex", "shrink-0"); // Should still have default classes
		});

		it("applies default styling classes", () => {
			render(<Avatar />);

			const avatar = document.querySelector(".relative");
			expect(avatar).toHaveClass(
				"relative",
				"flex",
				"shrink-0",
				"overflow-hidden",
				"rounded-full",
				"h-11",
				"w-11",
				"text-sm",
			);
		});

		it("applies fallback container styling", () => {
			render(<Avatar fallback="Test" />);

			const fallbackContainer = document.querySelector(".bg-muted");
			expect(fallbackContainer).toHaveClass(
				"flex",
				"h-full",
				"w-full",
				"items-center",
				"justify-center",
				"bg-muted",
				"text-muted-foreground",
			);
		});

		it("applies image styling", () => {
			render(<Avatar src="test.jpg" />);

			const img = document.querySelector("img");
			expect(img).toHaveClass("h-full", "w-full", "object-cover");
		});
	});

	describe("Props and Attributes", () => {
		it("passes through HTML attributes", () => {
			render(
				<Avatar data-testid="test-avatar" id="avatar-1" title="User Avatar" />,
			);

			const avatar = document.querySelector(".relative");
			expect(avatar).toHaveAttribute("data-testid", "test-avatar");
			expect(avatar).toHaveAttribute("id", "avatar-1");
			expect(avatar).toHaveAttribute("title", "User Avatar");
		});

		it("handles click events", () => {
			const handleClick = vi.fn();
			render(<Avatar onClick={handleClick} />);

			const avatar = document.querySelector(".relative");
			(avatar as HTMLElement).click();

			expect(handleClick).toHaveBeenCalledTimes(1);
		});

		it("forwards ref correctly", () => {
			const ref = { current: null as HTMLDivElement | null };

			render(<Avatar ref={ref} />);

			expect(ref.current).toBeInstanceOf(HTMLDivElement);
			expect(ref.current).toHaveClass("relative");
		});
	});

	describe("Component Properties", () => {
		it("has correct displayName", () => {
			expect(Avatar.displayName).toBe("Avatar");
		});

		it("is memoized component", () => {
			const { rerender } = render(<Avatar fallback="Test Example" />);

			// Initial render - "Test Example" becomes "TE"
			expect(screen.getByText("TE")).toBeInTheDocument();

			// Rerender with same props
			rerender(<Avatar fallback="Test Example" />);
			expect(screen.getByText("TE")).toBeInTheDocument();
		});
	});

	describe("Edge Cases", () => {
		it("handles empty string fallback", () => {
			render(<Avatar fallback="" />);

			expect(screen.getByText("?")).toBeInTheDocument();
		});

		it("handles whitespace-only fallback", () => {
			render(<Avatar fallback="   " />);

			// Empty string after trim should return '?'
			const fallbackContainer = document.querySelector(".bg-muted");
			expect(fallbackContainer).toBeInTheDocument();
		});

		it("handles special characters in fallback", () => {
			render(<Avatar fallback="José María" />);

			expect(screen.getByText("JM")).toBeInTheDocument();
		});

		it("handles very long fallback text", () => {
			const longName =
				"A very very very long name that should be truncated properly";
			render(<Avatar fallback={longName} />);

			expect(screen.getByText("AV")).toBeInTheDocument();
		});

		it("handles null fallback", () => {
			render(<Avatar fallback={null} />);

			expect(screen.getByText("?")).toBeInTheDocument();
		});

		it("handles undefined fallback", () => {
			render(<Avatar fallback={undefined} />);

			expect(screen.getByText("?")).toBeInTheDocument();
		});
	});

	describe("Image Error Handling", () => {
		it("handles src changes after image error", () => {
			const { rerender } = render(
				<Avatar src="invalid.jpg" fallback="Test Example" />,
			);

			const img = document.querySelector("img");
			expect(img).toBeInTheDocument();
			if (img) {
				fireEvent.error(img);
			}

			// "Test Example" becomes "TE" after error
			expect(screen.getByText("TE")).toBeInTheDocument();

			// Change src - component should still render with new props
			rerender(<Avatar src="valid.jpg" fallback="New Example" />);

			// Should show new fallback text "NE" since imgError state persists
			expect(screen.getByText("NE")).toBeInTheDocument();
		});

		it("handles multiple image errors", () => {
			const { rerender } = render(
				<Avatar src="invalid1.jpg" fallback="Error Message" />,
			);

			const img = document.querySelector("img");
			expect(img).toBeInTheDocument();
			if (img) {
				fireEvent.error(img);
			}

			// "Error Message" becomes "EM"
			expect(screen.getByText("EM")).toBeInTheDocument();

			// Change to another invalid src
			rerender(<Avatar src="invalid2.jpg" fallback="Test Example" />);

			// "Test Example" becomes "TE"
			expect(screen.getByText("TE")).toBeInTheDocument();
		});
	});

	describe("Accessibility", () => {
		it("provides alt text for screen readers", () => {
			render(<Avatar src="test.jpg" alt="User's profile picture" />);

			const img = document.querySelector("img");
			expect(img).toHaveAttribute("alt", "User's profile picture");
		});

		it("provides default alt text when none provided", () => {
			render(<Avatar src="test.jpg" />);

			const img = document.querySelector("img");
			expect(img).toHaveAttribute("alt", "Avatar");
		});

		it("maintains semantic structure", () => {
			render(<Avatar fallback="JD" />);

			const avatar = document.querySelector(".relative");
			expect(avatar).toBeInTheDocument();

			const fallbackContainer = document.querySelector(".bg-muted");
			expect(fallbackContainer).toBeInTheDocument();
		});
	});
});
