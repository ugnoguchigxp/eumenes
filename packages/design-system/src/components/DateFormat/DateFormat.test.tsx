import { render, screen } from "@testing-library/react";
import { useTranslation } from "react-i18next";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	CalendarProvider,
	type SecondaryCalendar,
} from "@/contexts/CalendarContext";
import { DateFormat, resetFormatterCache } from "./DateFormat";

// Mock react-i18next
vi.mock("react-i18next", () => ({
	useTranslation: vi.fn(),
}));

// Helper to render with Calendar settings
const renderWithSettings = (
	ui: React.ReactNode,
	{
		secondaryCalendar = "none",
		preferLocalCalendar = false,
	}: {
		secondaryCalendar?: SecondaryCalendar;
		preferLocalCalendar?: boolean;
	} = {},
) => {
	return render(
		<CalendarProvider
			defaultSecondaryCalendar={secondaryCalendar}
			defaultPreferLocalCalendar={preferLocalCalendar}
		>
			{ui}
		</CalendarProvider>,
	);
};

describe("DateFormat", () => {
	beforeEach(() => {
		resetFormatterCache();
		vi.mocked(useTranslation).mockReturnValue({
			i18n: { language: "en-US" },
			t: (k: string) => k,
			// biome-ignore lint/suspicious/noExplicitAny: Mocking complex i18next return type
		} as any);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		resetFormatterCache();
	});

	it("renders placeholder when date is null", () => {
		renderWithSettings(<DateFormat date={null} />);
		expect(screen.getByText("-")).toBeInTheDocument();
	});

	it("renders placeholder when date is undefined", () => {
		renderWithSettings(<DateFormat date={undefined} />);
		expect(screen.getByText("-")).toBeInTheDocument();
	});

	it("renders placeholder when date is invalid", () => {
		renderWithSettings(<DateFormat date="invalid-date" />);
		expect(screen.getByText("-")).toBeInTheDocument();
	});

	it("formats date string correctly (Gregorian, EN)", () => {
		renderWithSettings(<DateFormat date="2025-10-23" />);
		expect(screen.getByText(/Oct 23, 2025/)).toBeInTheDocument();
	});

	it("formats Date object correctly", () => {
		renderWithSettings(<DateFormat date={new Date(2025, 9, 23)} />);
		expect(screen.getByText(/Oct 23, 2025/)).toBeInTheDocument();
	});

	it("shows time when requested", () => {
		const d = new Date(2025, 9, 23, 14, 30);
		renderWithSettings(<DateFormat date={d} showTime />);
		expect(screen.getByText(/2:30 PM/)).toBeInTheDocument();
	});

	it("shows day of week when requested", () => {
		renderWithSettings(<DateFormat date="2025-10-23" showDayOfWeek />);
		expect(screen.getByText(/Thu/)).toBeInTheDocument();
	});

	it("applies custom className", () => {
		renderWithSettings(
			<DateFormat date="2025-10-23" className="custom-date" />,
		);
		const span = screen.getByText(/Oct 23, 2025/);
		expect(span).toHaveClass("custom-date");
	});

	describe("Date Parsing", () => {
		it("parses ISO date string without timezone shift", () => {
			renderWithSettings(<DateFormat date="2025-12-31" />);
			expect(screen.getByText(/Dec 31, 2025/)).toBeInTheDocument();
		});

		it("parses datetime string with timezone", () => {
			renderWithSettings(<DateFormat date="2025-10-23T14:30:00Z" />);
			expect(screen.getByText(/Oct 23, 2025/)).toBeInTheDocument();
		});

		it("handles leap year dates", () => {
			renderWithSettings(<DateFormat date="2024-02-29" />);
			expect(screen.getByText(/Feb 29, 2024/)).toBeInTheDocument();
		});

		it("handles invalid date string gracefully", () => {
			renderWithSettings(<DateFormat date="not-a-date" />);
			expect(screen.getByText("-")).toBeInTheDocument();
		});

		it("handles edge case invalid dates", () => {
			renderWithSettings(<DateFormat date="2025-13-01" />);
			const content = screen.getByText((text) => text.length > 0);
			expect(content).toBeInTheDocument();
		});
	});

	describe("Calendar Systems", () => {
		it("uses Gregorian calendar by default", () => {
			renderWithSettings(<DateFormat date="2025-10-23" calendar="gregorian" />);
			expect(screen.getByText(/Oct 23, 2025/)).toBeInTheDocument();
		});

		it("handles Japanese calendar with English locale", () => {
			renderWithSettings(<DateFormat date="2025-10-23" calendar="japanese" />);
			expect(screen.getByText(/令和7年/)).toBeInTheDocument();
		});

		it("handles Buddhist calendar", () => {
			renderWithSettings(<DateFormat date="2025-10-23" calendar="buddhist" />);
			expect(screen.getByText(/2568/)).toBeInTheDocument();
		});

		it("handles Islamic calendar", () => {
			renderWithSettings(<DateFormat date="2025-10-23" calendar="islamic" />);
			const content = screen.getByText(
				(text) => text.length > 0 && text !== "-",
			);
			expect(content).toBeInTheDocument();
		});

		it("handles Chinese calendar", () => {
			renderWithSettings(<DateFormat date="2025-10-23" calendar="chinese" />);
			const content = screen.getByText(
				(text) => text.length > 0 && text !== "-",
			);
			expect(content).toBeInTheDocument();
		});
	});

	describe("Localization (Japanese)", () => {
		it("formats correctly in Japanese", () => {
			renderWithSettings(<DateFormat date="2025-10-23" locale="ja-JP" />);
			expect(screen.getByText(/2025\/10\/23/)).toBeInTheDocument();
		});

		it("uses JP specific options when calendar is japanese", () => {
			renderWithSettings(
				<DateFormat date="2025-10-23" calendar="japanese" locale="ja-JP" />,
			);
			expect(screen.getByText(/令和7年10月23日/)).toBeInTheDocument();
		});

		it("shows time in Japanese format", () => {
			const d = new Date(2025, 9, 23, 14, 30);
			renderWithSettings(<DateFormat date={d} showTime locale="ja-JP" />);
			expect(screen.getByText(/14:30/)).toBeInTheDocument();
		});
	});

	describe("Secondary Calendar", () => {
		it("shows secondary calendar when enabled", () => {
			renderWithSettings(<DateFormat date="2025-10-23" showSecondary />, {
				secondaryCalendar: "japanese",
			});
			expect(screen.getByText(/\(/)).toBeInTheDocument();
			expect(screen.getByText(/\)/)).toBeInTheDocument();
		});

		it("does not show secondary when preferLocalCalendar is true", () => {
			renderWithSettings(<DateFormat date="2025-10-23" showSecondary />, {
				secondaryCalendar: "japanese",
				preferLocalCalendar: true,
			});
			expect(screen.queryByText(/\(/)).not.toBeInTheDocument();
		});

		it("does not show secondary when secondary is none", () => {
			renderWithSettings(<DateFormat date="2025-10-23" showSecondary />, {
				secondaryCalendar: "none",
			});
			expect(screen.queryByText(/\(/)).not.toBeInTheDocument();
		});

		it("does not show secondary when secondary equals primary", () => {
			renderWithSettings(
				<DateFormat date="2025-10-23" calendar="japanese" showSecondary />,
				{
					secondaryCalendar: "japanese",
				},
			);
			expect(screen.queryByText(/\(/)).not.toBeInTheDocument();
		});

		it("formats Buddhist secondary calendar", () => {
			renderWithSettings(<DateFormat date="2025-10-23" showSecondary />, {
				secondaryCalendar: "buddhist",
			});
			expect(screen.getByText(/\(/)).toBeInTheDocument();
			expect(screen.getByText(/2568/)).toBeInTheDocument();
		});
	});

	describe("Prefer Local Calendar", () => {
		it("auto-detects Japanese calendar for ja locale", () => {
			renderWithSettings(<DateFormat date="2025-01-01" locale="ja-JP" />, {
				preferLocalCalendar: true,
			});
			expect(screen.getByText(/令和/)).toBeInTheDocument();
		});

		it("auto-detects Buddhist calendar for th locale", () => {
			renderWithSettings(<DateFormat date="2025-01-01" locale="th-TH" />, {
				preferLocalCalendar: true,
			});
			expect(screen.getByText(/2568/)).toBeInTheDocument();
		});

		it("falls back to Gregorian for unsupported locales", () => {
			renderWithSettings(<DateFormat date="2025-01-01" locale="fr-FR" />, {
				preferLocalCalendar: true,
			});
			expect(screen.getByText(/2025/)).toBeInTheDocument();
		});
	});

	describe("Error Handling", () => {
		it("falls back to base locale on formatting error", () => {
			const originalIntl = Intl.DateTimeFormat;
			// biome-ignore lint/suspicious/noExplicitAny: Mocking internal implementation
			// biome-ignore lint/complexity/useArrowFunction: Constructor mock requires function type
			const mockImpl: any = function (loc: any, opts: any) {
				if (typeof loc === "string" && loc.includes("-u-ca-")) {
					throw new Error("Calendar not supported");
				}
				return new originalIntl(loc, opts);
			};
			const spy = vi.spyOn(Intl, "DateTimeFormat").mockImplementation(mockImpl);

			renderWithSettings(<DateFormat date="2025-10-23" calendar="japanese" />);
			expect(screen.getByText(/Oct 23, 2025/)).toBeInTheDocument();

			spy.mockRestore();
		});
	});

	describe("Complex Combinations", () => {
		it("combines all options for Japanese locale", () => {
			vi.mocked(useTranslation).mockReturnValue({
				i18n: { language: "ja-JP" },
				t: (k: string) => k,
				// biome-ignore lint/suspicious/noExplicitAny: Mocking complex i18next return type
			} as any);

			const d = new Date(2025, 9, 23, 14, 30);
			renderWithSettings(
				<DateFormat
					date={d}
					showTime
					showDayOfWeek
					calendar="japanese"
					className="complex-date"
				/>,
			);

			const mainElement = screen.getByText(/令和/);
			expect(mainElement).toBeInTheDocument();
			expect(mainElement).toHaveClass("complex-date");
			expect(screen.getByText(/14:30/)).toBeInTheDocument();
			expect(screen.getByText(/木/)).toBeInTheDocument();
		});

		it("combines secondary calendar with time and day", () => {
			const d = new Date(2025, 9, 23, 14, 30);
			renderWithSettings(
				<DateFormat date={d} showTime showDayOfWeek showSecondary />,
				{ secondaryCalendar: "buddhist" },
			);

			const mainElements = screen.getAllByText(/Oct 23, 2025/);
			expect(mainElements.length).toBeGreaterThan(0);
			expect(screen.getByText(/\(/)).toBeInTheDocument();
			const secondaryContent = screen.getAllByText(
				(text) => text.includes("2568") || text.includes("ต.ค."),
			);
			expect(secondaryContent.length).toBeGreaterThan(0);
		});
	});
});
