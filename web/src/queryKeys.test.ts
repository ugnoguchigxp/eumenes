import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { expect, test, vi } from "vitest";
import {
	invalidateAllButLive,
	queryRoots,
	subscribeQueryRefresh,
} from "./queryKeys";

test.each(["explicit reconnect", "stream reset"] as const)(
	"%s refetches ordinary queries and only marks live provider queries stale",
	async (trigger) => {
		const cache = new QueryClient();
		const settings = vi.fn(async () => "settings");
		const diagnostics = vi.fn(async () => "diagnostics");
		// Active observers are what make invalidation refetch.
		const subs = (
			[
				[queryRoots.settings, settings],
				[queryRoots.settingsDiagnostics, diagnostics],
			] as const
		).map(([root, queryFn]) =>
			new QueryObserver(cache, { queryKey: [root, "a"], queryFn }).subscribe(
				() => {},
			),
		);
		await vi.waitFor(() => {
			expect(cache.getQueryState([queryRoots.settings, "a"])?.status).toBe(
				"success",
			);
			expect(
				cache.getQueryState([queryRoots.settingsDiagnostics, "a"])?.status,
			).toBe("success");
		});
		const unsubscribe =
			trigger === "stream reset"
				? subscribeQueryRefresh(cache, (notify) => {
						notify("reset");
						return () => {};
					})
				: undefined;
		if (trigger === "explicit reconnect") await invalidateAllButLive(cache);
		await vi.waitFor(() => expect(settings).toHaveBeenCalledTimes(2));
		expect(diagnostics).toHaveBeenCalledTimes(1);
		expect(
			cache.getQueryState([queryRoots.settingsDiagnostics, "a"])?.isInvalidated,
		).toBe(true);
		unsubscribe?.();
		for (const stop of subs) stop();
		cache.clear();
	},
);
