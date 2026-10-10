import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { expect, test, vi } from "vitest";
import { invalidateAllButLive, queryRoots } from "./queryKeys";

test("invalidateAllButLive refetches ordinary queries and only marks live provider queries stale", async () => {
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
	await invalidateAllButLive(cache);
	expect(settings).toHaveBeenCalledTimes(2);
	expect(diagnostics).toHaveBeenCalledTimes(1);
	expect(
		cache.getQueryState([queryRoots.settingsDiagnostics, "a"])?.isInvalidated,
	).toBe(true);
	for (const unsubscribe of subs) unsubscribe();
	cache.clear();
});
