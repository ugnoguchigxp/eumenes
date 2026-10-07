import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useIsMobile } from "./useMobile";

describe("useIsMobile", () => {
	// Mock matchMedia
	const createMatchMedia = (matches: boolean) => {
		return vi.fn().mockImplementation((query) => ({
			matches,
			media: query,
			onchange: null,
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
			dispatchEvent: vi.fn(),
		}));
	};

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("returns false initially when matchMedia is not matching (desktop)", () => {
		window.matchMedia = createMatchMedia(false);
		const { result } = renderHook(() => useIsMobile());
		expect(result.current).toBe(false);
	});

	it("returns true initially when matchMedia matches (mobile)", () => {
		window.matchMedia = createMatchMedia(true);
		const { result } = renderHook(() => useIsMobile());
		expect(result.current).toBe(true);
	});

	it("updates when media query change event fires", () => {
		const addEventListenerMock = vi.fn();
		let changeCallback: (e: { matches: boolean }) => void = () => {};

		window.matchMedia = vi.fn().mockImplementation((query) => ({
			matches: false,
			media: query,
			onchange: null,
			addEventListener: addEventListenerMock.mockImplementation((event, cb) => {
				if (event === "change") {
					changeCallback = cb;
				}
			}),
			removeEventListener: vi.fn(),
		}));

		const { result } = renderHook(() => useIsMobile());
		expect(result.current).toBe(false);

		// Simulate resize/change to mobile
		act(() => {
			changeCallback({ matches: true });
		});

		expect(result.current).toBe(true);

		// Simulate resize/change back to desktop
		act(() => {
			changeCallback({ matches: false });
		});

		expect(result.current).toBe(false);
	});

	it("handles missing matchMedia (SSR fallback)", () => {
		// Temporarily delete matchMedia
		const originalMatchMedia = window.matchMedia;
		// @ts-expect-error
		delete window.matchMedia;

		const { result } = renderHook(() => useIsMobile());
		expect(result.current).toBe(false);

		// Restore
		window.matchMedia = originalMatchMedia;
	});
});
