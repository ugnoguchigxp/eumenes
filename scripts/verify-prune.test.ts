import { expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPrune, planPrune } from "./verify-prune";

function makeDir(
	base: string,
	name: string,
	size: number,
	ageDays: number,
	now: number,
) {
	const dir = join(base, name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "blob.bin"), Buffer.alloc(size, 1));
	const mtime = new Date(now - ageDays * 86_400_000);
	utimesSync(dir, mtime, mtime);
	return dir;
}

test("planPrune is read-only and separates old, recent, running, and protected investigation dirs", () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-prune-"));
	try {
		const now = Date.parse("2026-11-22T12:00:00Z");
		makeDir(dir, "old-investigation", 4096, 20, now);
		makeDir(dir, "recent-investigation", 2048, 3, now);
		makeDir(dir, "protected-investigation", 3072, 30, now);
		const running = makeDir(dir, "running-investigation", 1024, 30, now);
		writeFileSync(
			join(running, "report.json"),
			JSON.stringify({ result: "running" }),
		);
		const mtime = new Date(now - 30 * 86_400_000);
		utimesSync(running, mtime, mtime);

		const plan = planPrune(dir, {
			days: 14,
			keep: ["protected-investigation"],
			now,
		});
		const byName = Object.fromEntries(plan.entries.map((e) => [e.name, e]));
		expect(byName["old-investigation"]!.candidate).toBe(true);
		expect(byName["recent-investigation"]!.candidate).toBe(false);
		expect(byName["protected-investigation"]!.candidate).toBe(false);
		expect(byName["running-investigation"]!.candidate).toBe(false);
		expect(byName["running-investigation"]!.running).toBe(true);
		expect(plan.reclaimableBytes).toBe(4096);
		// dry-run does not delete anything
		expect(existsSync(join(dir, "old-investigation"))).toBe(true);

		const { removedInvestigations } = applyPrune(dir, {
			days: 14,
			keep: ["protected-investigation"],
			now,
		});
		expect(removedInvestigations).toEqual(["old-investigation"]);
		expect(existsSync(join(dir, "old-investigation"))).toBe(false);
		expect(existsSync(join(dir, "recent-investigation"))).toBe(true);
		expect(existsSync(join(dir, "protected-investigation"))).toBe(true);
		expect(existsSync(join(dir, "running-investigation"))).toBe(true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
