import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AsyncDataWrapper } from "./AsyncDataWrapper";

// Mock dependencies
vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, defaultValue?: string) => defaultValue || key,
		i18n: {
			language: "en",
			changeLanguage: vi.fn(),
		},
	}),
}));

vi.mock("../../../src/components/ErrorState/ErrorState", () => ({
	ErrorState: ({ error, onRetry }: { error: unknown; onRetry: () => void }) => (
		<div data-testid="error-state">
			<div data-testid="error-message">{String(error)}</div>
			<button data-testid="retry-button" type="button" onClick={onRetry}>
				Retry
			</button>
		</div>
	),
}));

vi.mock("../../../src/components/Skeleton/Skeleton", () => ({
	Skeleton: ({ className }: { className?: string }) => (
		<div data-testid="skeleton" className={className}>
			Skeleton
		</div>
	),
}));

vi.mock("../../../src/components/Spinner/Spinner", () => ({
	Spinner: ({ size, variant }: { size?: string; variant?: string }) => (
		<div
			data-testid="spinner"
			data-size={size || "md"}
			data-variant={variant || "default"}
		>
			Spinner
		</div>
	),
}));

vi.mock("@/utils/../", () => ({
	cn: (...classes: (string | undefined)[]) => classes.filter(Boolean).join(" "),
}));

describe("AsyncDataWrapper Component", () => {
	const mockRefetch = vi.fn();
	const mockChildren = <div data-testid="children">Content loaded</div>;

	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe("Error State", () => {
		it("renders ErrorState when isError is provided", () => {
			const error = new Error("Something went wrong");

			render(
				<AsyncDataWrapper
					isLoading={false}
					isError={error}
					refetch={mockRefetch}
				>
					{mockChildren}
				</AsyncDataWrapper>,
			);

			expect(screen.getByTestId("error-state")).toBeInTheDocument();
			expect(screen.getByTestId("error-message")).toHaveTextContent(
				"Something went wrong",
			);
			expect(screen.getByTestId("retry-button")).toBeInTheDocument();
		});

		it("applies custom className in error state", () => {
			render(
				<AsyncDataWrapper
					isLoading={false}
					isError="Error occurred"
					refetch={mockRefetch}
					className="custom-error-class"
				>
					{mockChildren}
				</AsyncDataWrapper>,
			);

			const errorContainer = screen.getByTestId("error-state").parentElement;
			expect(errorContainer).toHaveClass(
				"custom-error-class",
				"h-full",
				"flex",
				"items-center",
				"justify-center",
				"p-8",
			);
		});

		it("calls refetch when retry button is clicked", () => {
			render(
				<AsyncDataWrapper
					isLoading={false}
					isError="Network error"
					refetch={mockRefetch}
				>
					{mockChildren}
				</AsyncDataWrapper>,
			);

			const retryButton = screen.getByTestId("retry-button");
			retryButton.click();

			expect(mockRefetch).toHaveBeenCalledTimes(1);
		});

		it("handles string error", () => {
			render(
				<AsyncDataWrapper
					isLoading={false}
					isError="String error message"
					refetch={mockRefetch}
				>
					{mockChildren}
				</AsyncDataWrapper>,
			);

			expect(screen.getByTestId("error-message")).toHaveTextContent(
				"String error message",
			);
		});

		it("handles object error", () => {
			const error = { message: "Object error", code: 500 };

			render(
				<AsyncDataWrapper
					isLoading={false}
					isError={error}
					refetch={mockRefetch}
				>
					{mockChildren}
				</AsyncDataWrapper>,
			);

			expect(screen.getByTestId("error-message")).toHaveTextContent(
				"[object Object]",
			);
		});
	});

	describe("Loading State with Skeleton", () => {
		it("renders skeleton loading when useSkeletonLoading is true (default)", () => {
			render(
				<AsyncDataWrapper isLoading={true} isError={null} refetch={mockRefetch}>
					{mockChildren}
				</AsyncDataWrapper>,
			);

			expect(screen.getAllByTestId("skeleton")).toHaveLength(5);
			expect(screen.getByTestId("spinner")).toBeInTheDocument();
			expect(screen.getByTestId("spinner")).toHaveAttribute("data-size", "lg");
			expect(screen.getByText("Loading...")).toBeInTheDocument();
		});

		it("applies correct classes for skeleton loading", () => {
			render(
				<AsyncDataWrapper
					isLoading={true}
					isError={null}
					refetch={mockRefetch}
					className="custom-loading-class"
				>
					{mockChildren}
				</AsyncDataWrapper>,
			);

			const loadingContainer =
				screen.getByTestId("spinner").parentElement?.parentElement;
			expect(loadingContainer).toHaveClass(
				"custom-loading-class",
				"relative",
				"h-full",
				"w-full",
				"overflow-hidden",
				"p-4",
				"space-y-4",
			);
		});

		it("renders skeletons with correct classes", () => {
			render(
				<AsyncDataWrapper isLoading={true} isError={null} refetch={mockRefetch}>
					{mockChildren}
				</AsyncDataWrapper>,
			);

			const skeletons = screen.getAllByTestId("skeleton");
			skeletons.forEach((skeleton) => {
				expect(skeleton).toHaveClass("h-16", "w-full", "rounded-lg");
			});
		});

		it("positions spinner correctly in skeleton loading", () => {
			render(
				<AsyncDataWrapper isLoading={true} isError={null} refetch={mockRefetch}>
					{mockChildren}
				</AsyncDataWrapper>,
			);

			const spinnerContainer = screen.getByTestId("spinner").parentElement;
			expect(spinnerContainer).toHaveClass(
				"absolute",
				"inset-0",
				"flex",
				"flex-col",
				"items-center",
				"justify-center",
				"gap-2",
				"z-10",
			);
		});
	});

	describe("Loading State without Skeleton", () => {
		it("renders simple spinner when useSkeletonLoading is false", () => {
			render(
				<AsyncDataWrapper
					isLoading={true}
					isError={null}
					refetch={mockRefetch}
					useSkeletonLoading={false}
				>
					{mockChildren}
				</AsyncDataWrapper>,
			);

			expect(screen.getByTestId("spinner")).toBeInTheDocument();
			expect(screen.getByTestId("spinner")).toHaveAttribute("data-size", "lg");
			expect(screen.getByText("Loading...")).toBeInTheDocument();
			expect(screen.queryByTestId("skeleton")).not.toBeInTheDocument();
		});

		it("applies correct classes for simple loading", () => {
			render(
				<AsyncDataWrapper
					isLoading={true}
					isError={null}
					refetch={mockRefetch}
					useSkeletonLoading={false}
					className="custom-simple-loading"
				>
					{mockChildren}
				</AsyncDataWrapper>,
			);

			const loadingContainer = screen.getByTestId("spinner").parentElement;
			expect(loadingContainer).toHaveClass(
				"custom-simple-loading",
				"flex",
				"flex-col",
				"h-64",
				"items-center",
				"justify-center",
				"gap-2",
			);
		});
	});

	describe("Success State", () => {
		it("renders children when not loading and no error", () => {
			render(
				<AsyncDataWrapper
					isLoading={false}
					isError={null}
					refetch={mockRefetch}
				>
					{mockChildren}
				</AsyncDataWrapper>,
			);

			expect(screen.getByTestId("children")).toBeInTheDocument();
			expect(screen.getByTestId("children")).toHaveTextContent(
				"Content loaded",
			);
			expect(screen.queryByTestId("spinner")).not.toBeInTheDocument();
			expect(screen.queryByTestId("error-state")).not.toBeInTheDocument();
		});

		it("applies custom className in success state", () => {
			render(
				<AsyncDataWrapper
					isLoading={false}
					isError={null}
					refetch={mockRefetch}
					className="custom-success-class"
				>
					{mockChildren}
				</AsyncDataWrapper>,
			);

			const container = screen.getByTestId("children").parentElement;
			expect(container).toHaveClass("custom-success-class", "relative");
		});
	});

	describe("Fetching State", () => {
		it("shows fetching indicator when isFetching is true and not loading", () => {
			render(
				<AsyncDataWrapper
					isLoading={false}
					isError={null}
					refetch={mockRefetch}
					isFetching={true}
				>
					{mockChildren}
				</AsyncDataWrapper>,
			);

			expect(screen.getByTestId("children")).toBeInTheDocument();
			expect(screen.getByTestId("spinner")).toBeInTheDocument();
			expect(screen.getByTestId("spinner")).toHaveAttribute("data-size", "sm");
			expect(screen.getByTestId("spinner")).toHaveAttribute(
				"data-variant",
				"secondary",
			);
			expect(screen.getByText("Loading...")).toBeInTheDocument();
		});

		it("does not show fetching indicator when also loading", () => {
			render(
				<AsyncDataWrapper
					isLoading={true}
					isError={null}
					refetch={mockRefetch}
					isFetching={true}
					useSkeletonLoading={false}
				>
					{mockChildren}
				</AsyncDataWrapper>,
			);

			expect(screen.queryByTestId("children")).not.toBeInTheDocument();
			// Should show main loading spinner, not fetching spinner
			const spinner = screen.getByTestId("spinner");
			expect(spinner).toHaveAttribute("data-size", "lg");
			expect(spinner).toHaveAttribute("data-variant", "default");
		});

		it("positions fetching indicator correctly", () => {
			render(
				<AsyncDataWrapper
					isLoading={false}
					isError={null}
					refetch={mockRefetch}
					isFetching={true}
				>
					{mockChildren}
				</AsyncDataWrapper>,
			);

			const fetchingContainer = screen.getByTestId("spinner").parentElement;
			expect(fetchingContainer).toHaveClass(
				"absolute",
				"right-4",
				"top-3",
				"flex",
				"items-center",
				"gap-2",
				"text-xs",
				"text-muted-foreground",
				"z-20",
				"pointer-events-none",
			);
		});

		it("does not show fetching indicator when isFetching is false", () => {
			render(
				<AsyncDataWrapper
					isLoading={false}
					isError={null}
					refetch={mockRefetch}
					isFetching={false}
				>
					{mockChildren}
				</AsyncDataWrapper>,
			);

			expect(screen.getByTestId("children")).toBeInTheDocument();
			expect(screen.queryByTestId("spinner")).not.toBeInTheDocument();
		});
	});

	describe("Component Structure", () => {
		it("renders as container div", () => {
			render(
				<AsyncDataWrapper
					isLoading={false}
					isError={null}
					refetch={mockRefetch}
				>
					{mockChildren}
				</AsyncDataWrapper>,
			);

			const container = screen.getByTestId("children").parentElement;
			expect(container).toBeTruthy();
			expect(container?.tagName).toBe("DIV");
		});

		it("preserves children structure", () => {
			const complexChildren = (
				<div>
					<h1>Title</h1>
					<p>Content</p>
					<button type="button">Action</button>
				</div>
			);

			render(
				<AsyncDataWrapper
					isLoading={false}
					isError={null}
					refetch={mockRefetch}
				>
					{complexChildren}
				</AsyncDataWrapper>,
			);

			expect(
				screen.getByRole("heading", { name: "Title" }),
			).toBeInTheDocument();
			expect(screen.getByText("Content")).toBeInTheDocument();
			expect(
				screen.getByRole("button", { name: "Action" }),
			).toBeInTheDocument();
		});
	});

	describe("Edge Cases", () => {
		it("handles null children", () => {
			render(
				<AsyncDataWrapper
					isLoading={false}
					isError={null}
					refetch={mockRefetch}
				>
					{null}
				</AsyncDataWrapper>,
			);

			const container = document.querySelector(".relative");
			expect(container).toBeInTheDocument();
			expect(container).toBeEmptyDOMElement();
		});

		it("handles undefined children", () => {
			render(
				<AsyncDataWrapper
					isLoading={false}
					isError={null}
					refetch={mockRefetch}
				>
					{undefined}
				</AsyncDataWrapper>,
			);

			const container = document.querySelector(".relative");
			expect(container).toBeInTheDocument();
			expect(container).toBeEmptyDOMElement();
		});

		it("handles empty string children", () => {
			render(
				<AsyncDataWrapper
					isLoading={false}
					isError={null}
					refetch={mockRefetch}
				>
					{""}
				</AsyncDataWrapper>,
			);

			const container = document.querySelector(".relative");
			expect(container).toBeInTheDocument();
			expect(container).toBeEmptyDOMElement();
		});

		it("handles multiple children", () => {
			render(
				<AsyncDataWrapper
					isLoading={false}
					isError={null}
					refetch={mockRefetch}
				>
					<div data-testid="child1">Child 1</div>
					<div data-testid="child2">Child 2</div>
					<div data-testid="child3">Child 3</div>
				</AsyncDataWrapper>,
			);

			expect(screen.getByTestId("child1")).toBeInTheDocument();
			expect(screen.getByTestId("child2")).toBeInTheDocument();
			expect(screen.getByTestId("child3")).toBeInTheDocument();
		});
	});

	describe("Empty State", () => {
		it("renders empty state when isEmpty is true", () => {
			render(
				<AsyncDataWrapper
					isLoading={false}
					isError={null}
					refetch={mockRefetch}
					isEmpty={true}
				>
					{mockChildren}
				</AsyncDataWrapper>,
			);

			expect(screen.getByText("No data available")).toBeInTheDocument();
			expect(
				screen.getByRole("button", { name: "Refresh data" }),
			).toBeInTheDocument();
			expect(screen.queryByTestId("children")).not.toBeInTheDocument();
		});

		it("renders custom empty message", () => {
			render(
				<AsyncDataWrapper
					isLoading={false}
					isError={null}
					refetch={mockRefetch}
					isEmpty={true}
					emptyMessage="Custom empty message"
				>
					{mockChildren}
				</AsyncDataWrapper>,
			);

			expect(screen.getByText("Custom empty message")).toBeInTheDocument();
		});

		it("calls refetch when refresh button is clicked in empty state", () => {
			render(
				<AsyncDataWrapper
					isLoading={false}
					isError={null}
					refetch={mockRefetch}
					isEmpty={true}
				>
					{mockChildren}
				</AsyncDataWrapper>,
			);

			const refreshButton = screen.getByRole("button", {
				name: "Refresh data",
			});
			refreshButton.click();

			expect(mockRefetch).toHaveBeenCalledTimes(1);
		});
	});

	describe("Priority of States", () => {
		it("error state takes priority over loading", () => {
			render(
				<AsyncDataWrapper
					isLoading={true}
					isError="Error occurred"
					refetch={mockRefetch}
				>
					{mockChildren}
				</AsyncDataWrapper>,
			);

			expect(screen.getByTestId("error-state")).toBeInTheDocument();
			expect(screen.queryByTestId("spinner")).not.toBeInTheDocument();
			expect(screen.queryByTestId("children")).not.toBeInTheDocument();
		});

		it("loading state takes priority over success", () => {
			render(
				<AsyncDataWrapper
					isLoading={true}
					isError={null}
					refetch={mockRefetch}
					useSkeletonLoading={false}
				>
					{mockChildren}
				</AsyncDataWrapper>,
			);

			expect(screen.getByTestId("spinner")).toBeInTheDocument();
			expect(screen.queryByTestId("children")).not.toBeInTheDocument();
		});

		it("success state shows when no error or loading", () => {
			render(
				<AsyncDataWrapper
					isLoading={false}
					isError={null}
					refetch={mockRefetch}
				>
					{mockChildren}
				</AsyncDataWrapper>,
			);

			expect(screen.getByTestId("children")).toBeInTheDocument();
			expect(screen.queryByTestId("spinner")).not.toBeInTheDocument();
			expect(screen.queryByTestId("error-state")).not.toBeInTheDocument();
		});
	});
});
