import { expect, test } from "bun:test";
import {
	mkdtempSync,
	mkdirSync,
	writeFileSync,
	rmSync,
	renameSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { verificationRevision } from "./verification-inputs";

test("generated reports and builds do not invalidate verification; prompts, assets and fixtures do", () => {
	const root = mkdtempSync(join(tmpdir(), "verify-inputs-"));
	const put = (path: string, content: string) => {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), content);
	};
	try {
		put("api/domain/service.ts", "original");
		const baseline = verificationRevision(root);
		for (const path of [
			"spec/verification/run/results.json",
			"spec/verification/run/summary.md",
			"packages/design-system/dist/index.js",
			"verification-reports/latest.json",
			"data/settings.json",
			"node_modules/package/index.ts",
			"test-results/run/result.json",
		])
			put(path, "generated");
		expect(verificationRevision(root)).toBe(baseline);
		for (const path of [
			"api/domain/prompts/policy.md",
			"api/domain/data/settings.json",
			"api/domain/testdata/case.json",
			"web/index.html",
			"vendor/package.tgz",
			"bun.lock",
			"scripts/helper.py",
			"tests/browser/fixture.ts",
		])
			put(path, "input");
		for (const path of [
			"api/domain/service.ts",
			"api/domain/prompts/policy.md",
			"api/domain/data/settings.json",
			"api/domain/testdata/case.json",
			"web/index.html",
			"vendor/package.tgz",
			"bun.lock",
			"scripts/helper.py",
			"tests/browser/fixture.ts",
		]) {
			const before = verificationRevision(root);
			put(path, "changed");
			expect(verificationRevision(root)).not.toBe(before);
		}
		const before = verificationRevision(root);
		renameSync(
			join(root, "api/domain/service.ts"),
			join(root, "api/domain/renamed.ts"),
		);
		expect(verificationRevision(root)).not.toBe(before);
		rmSync(join(root, "api/domain/renamed.ts"));
		expect(verificationRevision(root)).not.toBe(before);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
