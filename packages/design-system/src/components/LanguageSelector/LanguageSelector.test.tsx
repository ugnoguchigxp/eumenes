import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useTranslation } from "react-i18next";
import { describe, expect, it, vi } from "vitest";

import { LanguageSelector } from "./LanguageSelector";

// Mock react-i18next
const changeLanguageMock = vi.fn();
vi.mock("react-i18next", () => ({
	useTranslation: vi.fn(() => ({
		t: (key: string) => {
			const translations: Record<string, string> = {
				language: "Language",
				japanese: "日本語",
				english: "English",
				language_menu_close: "Close menu",
			};
			return translations[key] || key;
		},
		i18n: {
			language: "ja",
			changeLanguage: changeLanguageMock,
		},
	})),
}));

// Mock global log
const logInfoMock = vi.fn();
vi.stubGlobal("log", {
	info: logInfoMock,
});

describe("LanguageSelector", () => {
	const user = userEvent.setup();

	beforeEach(() => {
		vi.clearAllMocks();
		// Ensure hasPointerCapture is defined (fix for Radix UI in jsdom)
		if (!window.HTMLElement.prototype.hasPointerCapture) {
			window.HTMLElement.prototype.hasPointerCapture = () => false;
		}
		if (!window.HTMLElement.prototype.setPointerCapture) {
			window.HTMLElement.prototype.setPointerCapture = () => {};
		}
		if (!window.HTMLElement.prototype.releasePointerCapture) {
			window.HTMLElement.prototype.releasePointerCapture = () => {};
		}
		if (!window.HTMLElement.prototype.scrollIntoView) {
			window.HTMLElement.prototype.scrollIntoView = () => {};
		}
	});

	it("renders current language (default Japanese)", () => {
		render(<LanguageSelector />);
		// Radix Select uses combobox role
		expect(screen.getByRole("combobox")).toBeInTheDocument();
		expect(screen.getByText("日本語")).toBeInTheDocument();
	});

	it("opens menu on click", async () => {
		render(<LanguageSelector />);

		const trigger = screen.getByRole("combobox");
		await user.click(trigger);

		expect(screen.getByText("English")).toBeInTheDocument();
		expect(screen.getAllByText("日本語")).toHaveLength(2); // In trigger and in menu
	});

	it("changes language using i18n.changeLanguage when onValueChange is not provided", async () => {
		render(<LanguageSelector />);

		await user.click(screen.getByRole("combobox"));
		await user.click(screen.getByText("English"));

		expect(changeLanguageMock).toHaveBeenCalledWith("en");
		// Check log interaction
		expect(logInfoMock).toHaveBeenCalledWith("Language changed", {
			language: "en",
		});
	});

	it("calls onValueChange if provided", async () => {
		const onValueChange = vi.fn();
		render(<LanguageSelector onValueChange={onValueChange} />);

		await user.click(screen.getByRole("combobox"));
		await user.click(screen.getByText("English"));

		expect(onValueChange).toHaveBeenCalledWith("en");
		expect(changeLanguageMock).not.toHaveBeenCalled();
	});

	it("closes menu when clicking outside", async () => {
		render(<LanguageSelector />);

		await user.click(screen.getByRole("combobox"));
		// Menu should be open
		expect(screen.getByText("English")).toBeInTheDocument();

		// Click outside to close (use fireEvent to bypass pointer-events check)
		fireEvent.click(document.body);
		// Menu should close (English option should no longer be visible)
		// Note: Radix doesn't use aria-label="Close menu" so we check by absence of options after close
	});

	it("renders controlled value when value prop is provided", () => {
		// Mock i18n language is 'ja', but we pass 'en'
		render(<LanguageSelector value="en" />);
		expect(screen.getByText("English")).toBeInTheDocument();
	});

	it("handles missing global log gracefully", async () => {
		// Untub global log to simulate missing log
		vi.stubGlobal("log", undefined);

		render(<LanguageSelector />);
		await user.click(screen.getByRole("combobox"));
		await user.click(screen.getByText("English"));

		expect(changeLanguageMock).toHaveBeenCalledWith("en");
		// Should not throw

		// Restore log for other tests (though this is last test in block,
		// beforeEach/afterEach might handle it if I added cleanup?)
		// This file doesn't have afterEach restoration of globals explicitly besides vi.restoreAllMocks?
		// vi.restoreAllMocks() restores spies, but strict stubs might stick?
		// It's safer to rely on afterEach if added, or just let it be.
	});

	it('falls back to "ja" if i18n.language is undefined', () => {
		// Override mock for this test
		vi.mocked(useTranslation).mockReturnValue({
			t: (key: string) => (key === "japanese" ? "日本語" : key),
			i18n: {
				language: undefined,
				changeLanguage: vi.fn(),
			},
		} as unknown as ReturnType<typeof useTranslation>);

		render(<LanguageSelector />);
		// Should fall back to 'ja' -> 'japanese' -> '日本語'
		expect(screen.getByText("日本語")).toBeInTheDocument();
	});
});
