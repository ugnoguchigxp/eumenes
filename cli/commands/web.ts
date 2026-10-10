import type { CommandRun } from "./types";

export const run: CommandRun = async (args, io) => {
	const { client, show } = io;
	const { positional, stable, fresh, readPages, wait } = args;
	const sub = positional.shift();
	if ((stable || fresh) && sub !== "read")
		throw new Error("--stable and --fresh require web read");
	if (readPages && sub !== "search")
		throw new Error("--read-pages requires web search");
	if (sub === "cache") {
		show(await client.researchCacheStatus());
		return 0;
	}
	if (sub === "clear") {
		show(await client.clearResearchCache());
		return 0;
	}
	if (sub === "run" && positional[0]) {
		show(await client.researchRun(positional[0]));
		return 0;
	}
	if (sub === "cancel" && positional[0]) {
		show(await client.cancelResearch(positional[0]));
		return 0;
	}
	if (sub !== "search" && sub !== "read")
		throw new Error(
			"usage: web search <query>|read <url>|run <id>|cancel <id>|cache|clear [--wait] [--fresh] [--stable] [--read-pages]",
		);
	const value = positional.join(" ").trim();
	if (!value) throw new Error("query or URL required");
	const requestId = args.explicitRequestId ?? crypto.randomUUID();
	const submitted = await client.submitResearch(
		sub === "read"
			? {
					requestId,
					operation: "read",
					url: value,
					retention: stable ? "stable" : "none",
					freshness: fresh || !stable ? "live" : "normal",
				}
			: {
					requestId,
					operation: "lookup",
					query: value,
					readPages: readPages ? 3 : 0,
					freshness: "live",
				},
	);
	if (!wait) {
		show(submitted);
		return 0;
	}
	let cancelled = false;
	const polling = new AbortController();
	const waitSignal = AbortSignal.any([
		polling.signal,
		AbortSignal.timeout(40000),
	]);
	const abort = () => {
		cancelled = true;
		polling.abort();
		void client
			.cancelResearch(submitted.id, AbortSignal.timeout(1000))
			.catch(() => {});
	};
	process.once("SIGINT", abort);
	try {
		const deadline = Date.now() + 40000;
		while (Date.now() < deadline) {
			const current = await client.researchRun(submitted.id, waitSignal);
			if (!["queued", "running"].includes(current.status)) {
				show(current);
				return current.status === "cancelled" || current.resultExpired
					? 4
					: ["completed", "partial"].includes(current.status)
						? 0
						: 3;
			}
			if (cancelled) {
				io.error(
					`run ${submitted.id}: cancellation requested; outcome unconfirmed`,
				);
				return 4;
			}
			await Bun.sleep(250);
		}
		await client
			.cancelResearch(submitted.id, AbortSignal.timeout(1000))
			.catch(() => {});
		io.error(
			`run ${submitted.id}: web research timed out; cancellation requested; outcome unconfirmed`,
		);
		return 4;
	} catch (error) {
		if (
			cancelled ||
			waitSignal.aborted ||
			(error instanceof Error &&
				["TimeoutError", "AbortError"].includes(error.name))
		) {
			if (!cancelled)
				void client
					.cancelResearch(submitted.id, AbortSignal.timeout(1000))
					.catch(() => {});
			io.error(
				`run ${submitted.id}: wait interrupted; cancellation requested; outcome unconfirmed`,
			);
			return 4;
		}
		throw error;
	} finally {
		process.removeListener("SIGINT", abort);
	}
};
