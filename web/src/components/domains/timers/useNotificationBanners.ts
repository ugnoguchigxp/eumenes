import { useEffect, useRef, useState } from "react";

const BANNER_DURATION_MS = 8_000;

/** Presentation only: collapsing a banner never acknowledges its notification. */
export function useNotificationBanners(keys: string[]) {
	const deadlines = useRef(new Map<string, number>());
	const [collapsed, setCollapsed] = useState(() => new Set<string>());
	useEffect(() => {
		const timers = keys
			.filter((key) => !collapsed.has(key))
			.map((key) => {
				const deadline =
					deadlines.current.get(key) ?? Date.now() + BANNER_DURATION_MS;
				deadlines.current.set(key, deadline);
				return setTimeout(
					() => {
						setCollapsed((previous) => new Set([...previous, key]));
					},
					Math.max(0, deadline - Date.now()),
				);
			});
		return () => timers.forEach(clearTimeout);
	}, [keys, collapsed]);
	return (key: string) => !collapsed.has(key);
}
