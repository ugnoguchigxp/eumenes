import { expect, it } from "bun:test";
import { ignoreError } from "./ignore-error";

it("records a debug event with the reason and swallows the failure", async () => {
	const calls: unknown[][] = [];
	const log = { debug: (...args: unknown[]) => void calls.push(args) };
	const boom = new Error("boom");
	await Promise.reject(boom).catch(ignoreError(log, "x.failed", "x_cleanup"));
	expect(calls).toEqual([["x.failed", { reason: "x_cleanup" }, boom]]);
});
