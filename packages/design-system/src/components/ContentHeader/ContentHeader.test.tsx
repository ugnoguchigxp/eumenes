import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ContentHeader } from "./ContentHeader";

// Mock AdaptiveText since it's complex
vi.mock("../../../src/components/AdaptiveText/AdaptiveText", () => ({
	AdaptiveText: ({ text, className }: { text: string; className?: string }) => (
		<span data-testid="adaptive-text" className={className}>
			{text}
		</span>
	),
}));

describe("ContentHeader Component", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe("Basic Rendering", () => {
		it("renders header with patient name", () => {
			render(<ContentHeader patientName="John Doe" />);

			const header = screen.getByRole("banner");
			expect(header).toBeInTheDocument();

			const patientName = screen.getByText("John Doe");
			expect(patientName).toBeInTheDocument();
			expect(patientName.tagName).toBe("H1");
		});

		it("renders as header element", () => {
			render(<ContentHeader patientName="Test Patient" />);

			const header = screen.getByRole("banner");
			expect(header.tagName).toBe("HEADER");
		});

		it("applies default classes", () => {
			render(<ContentHeader patientName="Test Patient" />);

			const header = screen.getByRole("banner");
			expect(header).toHaveClass(
				"w-full",
				"border-b",
				"border-border",
				"bg-background",
			);
		});
	});

	describe("Patient ID", () => {
		it("renders patient ID when provided", () => {
			render(<ContentHeader patientName="John Doe" patientId="12345678" />);

			const adaptiveText = screen.getByTestId("adaptive-text");
			expect(adaptiveText).toBeInTheDocument();
			expect(adaptiveText).toHaveTextContent("12345678");
		});

		it("truncates long patient ID", () => {
			render(<ContentHeader patientName="John Doe" patientId="123456789012" />);

			const adaptiveText = screen.getByTestId("adaptive-text");
			expect(adaptiveText).toHaveTextContent("12345678...");
		});

		it("does not render patient ID when not provided", () => {
			render(<ContentHeader patientName="John Doe" />);

			expect(screen.queryByTestId("adaptive-text")).not.toBeInTheDocument();
		});

		it("renders patient ID in correct container", () => {
			render(<ContentHeader patientName="John Doe" patientId="ID12345" />);

			const adaptiveText = screen.getByTestId("adaptive-text");
			const patientIdContainer = adaptiveText.parentElement;
			expect(patientIdContainer).toHaveClass(
				"text-sm",
				"text-muted-foreground",
				"bg-card",
				"rounded",
				"px-2",
				"py-1",
				"flex",
				"items-center",
				"max-w-[120px]",
			);
		});
	});

	describe("Additional Info", () => {
		it("renders additional info when provided", () => {
			render(
				<ContentHeader
					patientName="John Doe"
					additionalInfo="Additional information"
				/>,
			);

			const additionalInfo = screen.getByText("Additional information");
			expect(additionalInfo).toBeInTheDocument();
		});

		it("renders additional info as React element", () => {
			render(
				<ContentHeader
					patientName="John Doe"
					additionalInfo={<span data-testid="custom-info">Custom Info</span>}
				/>,
			);

			const customInfo = screen.getByTestId("custom-info");
			expect(customInfo).toBeInTheDocument();
			expect(customInfo).toHaveTextContent("Custom Info");
		});

		it("does not render additional info when not provided", () => {
			render(<ContentHeader patientName="John Doe" />);

			expect(screen.queryByText(/additional/i)).not.toBeInTheDocument();
		});

		it("applies correct classes to additional info", () => {
			render(
				<ContentHeader patientName="John Doe" additionalInfo="Info text" />,
			);

			const additionalInfo = screen.getByText("Info text");
			expect(additionalInfo).toHaveClass(
				"text-sm",
				"text-muted-foreground",
				"truncate",
			);
		});
	});

	describe("Layout and Structure", () => {
		it("renders correct header structure", () => {
			render(<ContentHeader patientName="John Doe" />);

			const header = screen.getByRole("banner");
			const container = header.querySelector(
				".flex.items-center.justify-between",
			);
			expect(container).toBeInTheDocument();

			const contentContainer = container?.querySelector(
				".flex.items-center.gap-3.min-w-0",
			);
			expect(contentContainer).toBeInTheDocument();
		});

		it("renders patient name and ID in correct container", () => {
			render(<ContentHeader patientName="John Doe" patientId="ID123" />);

			const nameContainer = screen.getByText("John Doe").parentElement;
			expect(nameContainer).toHaveClass(
				"flex",
				"items-center",
				"gap-2",
				"min-w-0",
			);
		});

		it("renders patient info in correct container", () => {
			render(<ContentHeader patientName="John Doe" />);

			const patientName = screen.getByText("John Doe");
			const infoContainer = patientName.closest(".min-w-0");
			expect(infoContainer).toBeInTheDocument();
		});
	});

	describe("Styling", () => {
		it("applies custom className", () => {
			render(
				<ContentHeader patientName="Test" className="custom-header-class" />,
			);

			const header = screen.getByRole("banner");
			expect(header).toHaveClass("custom-header-class");
		});

		it("merges custom className with default classes", () => {
			render(
				<ContentHeader
					patientName="Test"
					className="custom-class another-class"
				/>,
			);

			const header = screen.getByRole("banner");
			expect(header).toHaveClass(
				"w-full",
				"border-b",
				"border-border",
				"bg-background",
				"custom-class",
				"another-class",
			);
		});

		it("applies correct styles to patient name", () => {
			render(<ContentHeader patientName="John Doe" />);

			const patientName = screen.getByText("John Doe");
			expect(patientName).toHaveClass(
				"text-xl",
				"font-semibold",
				"text-foreground",
				"truncate",
			);
		});

		it("applies correct styles to container", () => {
			render(<ContentHeader patientName="John Doe" />);

			const header = screen.getByRole("banner");
			const flexContainer = header.querySelector(".flex");
			expect(flexContainer).toHaveClass(
				"items-center",
				"justify-between",
				"gap-4",
				"px-ui",
				"py-ui",
			);
		});
	});

	describe("Content Variations", () => {
		it("handles empty patient name", () => {
			render(<ContentHeader patientName="" />);

			const patientName = screen.getByRole("heading", { level: 1 });
			expect(patientName).toBeInTheDocument();
			expect(patientName).toHaveTextContent("");
			expect(patientName.tagName).toBe("H1");
		});

		it("handles long patient name", () => {
			const longName = "Very Long Patient Name That Should Be Truncated";
			render(<ContentHeader patientName={longName} />);

			const patientName = screen.getByText(longName);
			expect(patientName).toBeInTheDocument();
			expect(patientName).toHaveClass("truncate");
		});

		it("handles patient name with special characters", () => {
			const specialName = "John Doe @#$%^&*()";
			render(<ContentHeader patientName={specialName} />);

			const patientName = screen.getByText(specialName);
			expect(patientName).toBeInTheDocument();
		});

		it("handles patient name with emojis", () => {
			const emojiName = "John Doe 🏥 👨‍⚕️";
			render(<ContentHeader patientName={emojiName} />);

			const patientName = screen.getByText(emojiName);
			expect(patientName).toBeInTheDocument();
		});

		it("handles empty patient ID", () => {
			render(<ContentHeader patientName="John Doe" patientId="" />);

			// Empty string should not render the adaptive text (component behavior)
			expect(screen.queryByTestId("adaptive-text")).not.toBeInTheDocument();
		});

		it("handles patient ID with special characters", () => {
			render(<ContentHeader patientName="John Doe" patientId="ID-@#$%" />);

			const adaptiveText = screen.getByTestId("adaptive-text");
			expect(adaptiveText).toHaveTextContent("ID-@#$%");
		});

		it("handles complex additional info", () => {
			const complexInfo = (
				<div>
					<span>Line 1</span>
					<span>Line 2</span>
				</div>
			);

			render(
				<ContentHeader patientName="John Doe" additionalInfo={complexInfo} />,
			);

			expect(screen.getByText("Line 1")).toBeInTheDocument();
			expect(screen.getByText("Line 2")).toBeInTheDocument();
		});
	});

	describe("Accessibility", () => {
		it("uses semantic header element", () => {
			render(<ContentHeader patientName="John Doe" />);

			const header = screen.getByRole("banner");
			expect(header).toBeInTheDocument();
		});

		it("uses proper heading level for patient name", () => {
			render(<ContentHeader patientName="John Doe" />);

			const patientName = screen.getByRole("heading", { level: 1 });
			expect(patientName).toBeInTheDocument();
			expect(patientName).toHaveTextContent("John Doe");
		});
	});

	describe("Edge Cases", () => {
		it("renders with only required props", () => {
			render(<ContentHeader patientName="Minimal" />);

			const header = screen.getByRole("banner");
			const patientName = screen.getByText("Minimal");

			expect(header).toBeInTheDocument();
			expect(patientName).toBeInTheDocument();
			expect(screen.queryByTestId("adaptive-text")).not.toBeInTheDocument();
		});

		it("handles all props provided", () => {
			render(
				<ContentHeader
					patientName="Full Name"
					patientId="1234567890"
					additionalInfo="Full additional info"
					className="full-class"
				/>,
			);

			expect(screen.getByText("Full Name")).toBeInTheDocument();
			expect(screen.getByTestId("adaptive-text")).toBeInTheDocument();
			expect(screen.getByText("Full additional info")).toBeInTheDocument();

			const header = screen.getByRole("banner");
			expect(header).toHaveClass("full-class");
		});

		it("handles null additional info", () => {
			render(<ContentHeader patientName="John Doe" additionalInfo={null} />);

			expect(screen.getByText("John Doe")).toBeInTheDocument();
			expect(screen.queryByText(/null/i)).not.toBeInTheDocument();
		});

		it("handles undefined additional info", () => {
			render(
				<ContentHeader patientName="John Doe" additionalInfo={undefined} />,
			);

			expect(screen.getByText("John Doe")).toBeInTheDocument();
		});
	});

	describe("Navigation", () => {
		it("renders back button when onBack provided", async () => {
			const user = userEvent.setup();
			const onBack = vi.fn();
			render(<ContentHeader patientName="Test" onBack={onBack} />);

			const button = screen.getByRole("button", { name: /戻る/i });
			expect(button).toBeInTheDocument();

			await user.click(button);
			expect(onBack).toHaveBeenCalledTimes(1);
		});

		it("renders custom back label", () => {
			const onBack = vi.fn();
			render(
				<ContentHeader
					patientName="Test"
					onBack={onBack}
					backLabel="Go Back"
				/>,
			);

			expect(
				screen.getByRole("button", { name: /Go Back/i }),
			).toBeInTheDocument();
		});

		it("renders navigationBack content when provided", () => {
			render(
				<ContentHeader
					patientName="Test"
					navigationBack={<button type="button">Custom Nav</button>}
				/>,
			);
			expect(screen.getByText("Custom Nav")).toBeInTheDocument();
		});

		it("prioritizes onBack over navigationBack", () => {
			render(
				<ContentHeader
					patientName="Test"
					onBack={() => {}}
					navigationBack={<button type="button">Custom Nav</button>}
				/>,
			);
			// specific button from onBack (default label) should exist
			expect(screen.getByRole("button", { name: /戻る/i })).toBeInTheDocument();
			// navigationBack should not be rendered
			expect(screen.queryByText("Custom Nav")).not.toBeInTheDocument();
		});
	});

	describe("Component Behavior", () => {
		it("maintains consistent structure with different props", () => {
			const { rerender } = render(<ContentHeader patientName="Test" />);

			let header = screen.getByRole("banner");
			expect(header).toBeInTheDocument();

			rerender(<ContentHeader patientName="Test" patientId="ID123" />);
			header = screen.getByRole("banner");
			expect(header).toBeInTheDocument();
			expect(screen.getByTestId("adaptive-text")).toBeInTheDocument();

			rerender(
				<ContentHeader patientName="Test" additionalInfo="Additional" />,
			);
			header = screen.getByRole("banner");
			expect(header).toBeInTheDocument();
			expect(screen.getByText("Additional")).toBeInTheDocument();
		});
	});
});
