import * as React from "react";

const MOBILE_BREAKPOINT = 768;

export function useIsMobile(): boolean {
	const [isMobile, setIsMobile] = React.useState<boolean>(() => {
		if (typeof window !== "undefined" && window.matchMedia) {
			return window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`)
				.matches;
		}
		return false;
	});

	React.useEffect(() => {
		if (typeof window === "undefined" || !window.matchMedia) return;

		const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
		const onChange = (e: MediaQueryListEvent) => {
			setIsMobile(e.matches);
		};

		// Modern browsers
		if (mql.addEventListener) {
			mql.addEventListener("change", onChange);
		} else {
			// Fallback for older browsers (deprecated)
			mql.addListener(onChange);
		}

		// Ensure state is synced on mount
		setIsMobile(mql.matches);

		return () => {
			if (mql.removeEventListener) {
				mql.removeEventListener("change", onChange);
			} else {
				mql.removeListener(onChange);
			}
		};
	}, []);

	return isMobile;
}
