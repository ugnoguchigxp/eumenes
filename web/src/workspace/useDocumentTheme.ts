import { useEffect } from "react";

/** The page follows the saved theme; "system" follows the OS setting as it changes. */
export function useDocumentTheme(saved: string | undefined) {
	useEffect(() => {
		const media = window.matchMedia("(prefers-color-scheme: dark)");
		const apply = () => {
			const theme = saved ?? "system";
			document.documentElement.dataset.theme =
				theme === "system" ? (media.matches ? "dark" : "light") : theme;
		};
		apply();
		media.addEventListener("change", apply);
		return () => media.removeEventListener("change", apply);
	}, [saved]);
}
