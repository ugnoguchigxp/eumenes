import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	CurrencyFormat,
	NumberFormat,
	PercentFormat,
} from "@/components/NumberFormat/NumberFormat";

describe("NumberFormat Components", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	describe("NumberFormat", () => {
		it("formats numbers with default settings (en-US fallback)", () => {
			render(<NumberFormat value={1234.567} locale="en-US" />);
			expect(screen.getByText("1,234.567")).toBeInTheDocument();
		});

		it("formats numbers with custom locale (de-DE)", () => {
			render(<NumberFormat value={1234.567} locale="de-DE" />);
			expect(screen.getByText("1.234,567")).toBeInTheDocument();
		});

		it("renders fallback for null/undefined/NaN", () => {
			render(<NumberFormat value={null} fallback="N/A" />);
			expect(screen.getByText("N/A")).toBeInTheDocument();

			render(<NumberFormat value={undefined} fallback="-" />);
			expect(screen.getByText("-")).toBeInTheDocument();

			render(<NumberFormat value={NaN} fallback="Invalid" />);
			expect(screen.getByText("Invalid")).toBeInTheDocument();
		});

		it("supports Intl options", () => {
			render(
				<NumberFormat
					value={1234.567}
					locale="en-US"
					options={{ maximumFractionDigits: 1 }}
				/>,
			);
			expect(screen.getByText("1,234.6")).toBeInTheDocument();
		});
	});

	describe("CurrencyFormat", () => {
		it("formats currency (USD)", () => {
			render(<CurrencyFormat value={100} currency="USD" locale="en-US" />);
			expect(screen.getByText("$100.00")).toBeInTheDocument();
		});

		it("formats currency (JPY)", () => {
			render(<CurrencyFormat value={100} currency="JPY" locale="ja-JP" />);
			expect(screen.getByText(/[￥¥]100/)).toBeInTheDocument();
		});

		it("renders fallback for null", () => {
			render(<CurrencyFormat value={null} currency="USD" fallback="N/A" />);
			expect(screen.getByText("N/A")).toBeInTheDocument();
		});
	});

	describe("PercentFormat", () => {
		it("formats ratio by default (0.5 -> 50%)", () => {
			render(<PercentFormat value={0.5} locale="en-US" />);
			expect(screen.getByText("50%")).toBeInTheDocument();
		});

		it("formats percent scale (50 -> 50%)", () => {
			render(<PercentFormat value={50} valueScale="percent" locale="en-US" />);
			expect(screen.getByText("50%")).toBeInTheDocument();
		});

		it("respects fraction digits config", () => {
			render(
				<PercentFormat
					value={0.12345}
					locale="en-US"
					options={{ maximumFractionDigits: 2 }}
				/>,
			);
			expect(screen.getByText("12.35%")).toBeInTheDocument();
		});

		it("renders fallback for null", () => {
			render(<PercentFormat value={null} fallback="-" />);
			expect(screen.getByText("-")).toBeInTheDocument();
		});
	});

	describe("Locale Resolution & Error Handling", () => {
		it("resolves locale from data-number-format-locale attribute", () => {
			document.documentElement.setAttribute(
				"data-number-format-locale",
				"fr-FR",
			);

			render(<NumberFormat value={1234.567} />);
			expect(screen.getByText(/1.*234,567/)).toBeInTheDocument();

			document.documentElement.removeAttribute("data-number-format-locale");
		});

		it("resolves system locale when no override is present", () => {
			document.documentElement.removeAttribute("data-number-format-locale");
			render(<NumberFormat value={1234.567} />);
			expect(screen.getByText("1,234.567")).toBeInTheDocument();
		});

		it("falls back to default fallback (-) if Intl is undefined", () => {
			vi.stubGlobal("Intl", undefined);

			render(<NumberFormat value={1234.567} />);
			expect(screen.getByText("-")).toBeInTheDocument();
		});

		it("uses String(value) if Intl undefined and fallback string is null (unlikely but logic check)", () => {
			vi.stubGlobal("Intl", undefined);

			render(
				<NumberFormat value={1234.567} fallback={null as unknown as string} />,
			);
			expect(screen.getByText("1234.567")).toBeInTheDocument();
		});

		it("calls fallback if even en-US fails", () => {
			class MockBrokenNumberFormat {
				constructor() {
					throw new Error("Everything failed");
				}
				format() {
					return "";
				}
				resolvedOptions() {
					return {};
				}
			}

			const spy = vi
				.spyOn(Intl, "NumberFormat")
				/* biome-ignore lint/suspicious/noExplicitAny: Mocking complex object */
				.mockImplementation(MockBrokenNumberFormat as any);

			render(<NumberFormat value={1000} locale="en-US" fallback="Error" />);
			expect(screen.getByText("Error")).toBeInTheDocument();

			spy.mockRestore();
		});
	});
});
