import { render, screen } from "@testing-library/react";
import { useTranslation } from "react-i18next";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DateDisplay } from "./DateDisplay";

// Mock react-i18next
vi.mock("react-i18next", () => ({
	useTranslation: vi.fn(),
}));

describe("DateDisplay", () => {
	let currentLang = "en-US";

	beforeEach(() => {
		currentLang = "en-US";
		vi.mocked(useTranslation).mockReturnValue({
			i18n: { language: currentLang },
			t: (k: string) => k,
			// biome-ignore lint/suspicious/noExplicitAny: Mocking complex i18next return type
		} as any);
	});

	const testDate = new Date(2025, 9, 23); // Oct 23, 2025 (Thu)

	it("renders full format by default (EN)", () => {
		render(<DateDisplay date={testDate} />);
		// Thursday, 23 October 2025
		expect(screen.getByText(/Thursday, 23 October 2025/)).toBeInTheDocument();
	});

	it("renders date only (EN)", () => {
		render(<DateDisplay date={testDate} format="date" />);
		// 23 October 2025
		expect(screen.getByText(/23 October 2025/)).toBeInTheDocument();
	});

	it("renders weekday only (EN)", () => {
		render(<DateDisplay date={testDate} format="weekday" />);
		// Thursday
		expect(screen.getByText("Thursday")).toBeInTheDocument();
	});

	it("renders weekdayShort format (EN)", () => {
		render(<DateDisplay date={testDate} format="weekdayShort" />);
		// Thu
		expect(screen.getByText("Thu")).toBeInTheDocument();
	});

	it("renders yearMonth format (EN)", () => {
		render(<DateDisplay date={testDate} format="yearMonth" />);
		// October 2025
		expect(screen.getByText(/October 2025/)).toBeInTheDocument();
	});

	it("renders monthDay format (EN)", () => {
		render(<DateDisplay date={testDate} format="monthDay" />);
		// 23 October
		expect(screen.getByText(/23 October/)).toBeInTheDocument();
	});

	it("renders monthDayShort format (EN)", () => {
		render(<DateDisplay date={testDate} format="monthDayShort" />);
		// 23 Oct (Thu)
		expect(screen.getByText(/23 Oct \(Thu\)/)).toBeInTheDocument();
	});

	it("renders compact format (EN)", () => {
		render(<DateDisplay date={testDate} format="compact" />);
		const element = screen.getByText(
			(_content, element) => {
				return element?.textContent === "23\nThu";
			},
			{ selector: "span" },
		);
		expect(element).toBeInTheDocument();
	});

	describe("Japanese Localization", () => {
		it("renders full format (JA)", () => {
			render(<DateDisplay date={testDate} locale="ja" />);
			expect(screen.getByText(/2025年10月23日/)).toBeInTheDocument();
		});

		it("renders yearMonth format (JA)", () => {
			render(<DateDisplay date={testDate} format="yearMonth" locale="ja" />);
			expect(screen.getByText("2025年10月")).toBeInTheDocument();
		});

		it("renders monthDay format (JA)", () => {
			render(<DateDisplay date={testDate} format="monthDay" locale="ja" />);
			expect(screen.getByText("10月23日")).toBeInTheDocument();
		});

		it("renders monthDayShort format (JA)", () => {
			render(
				<DateDisplay date={testDate} format="monthDayShort" locale="ja" />,
			);
			expect(screen.getByText(/10\/23/)).toBeInTheDocument();
		});

		it("renders compact format (JA)", () => {
			render(<DateDisplay date={testDate} format="compact" locale="ja" />);
			const element = screen.getByText(
				(_content, element) => {
					return element?.textContent === "10/23\n(木)";
				},
				{ selector: "span" },
			);
			expect(element).toBeInTheDocument();
		});
	});
});
