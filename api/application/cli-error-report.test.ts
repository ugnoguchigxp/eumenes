import { expect, test } from "bun:test";
import { run } from "../../cli/commands/run";
import type { CliArgs, CliIo } from "../../cli/commands/types";

const args = (patch: Partial<CliArgs>): CliArgs => ({
	command: "run",
	positional: ["run-1"],
	json: false,
	wait: false,
	fresh: false,
	stable: false,
	readPages: false,
	errorReport: false,
	explicitRequestId: undefined,
	conversationId: "main",
	toolchainId: undefined,
	listCursor: undefined,
	listLimit: undefined,
	...patch,
});
const harness = () => {
	const shown: unknown[] = [];
	const calls: string[] = [];
	const io = {
		client: {
			run: async (id: string) => (calls.push(`run ${id}`), { id }),
			runErrorReport: async (id: string) => (
				calls.push(`report ${id}`),
				{ runId: id, text: "# Eumenes エラーレポート" }
			),
		},
		show: (value: unknown) => shown.push(value),
		error: () => {},
	} as unknown as CliIo;
	return { io, shown, calls };
};

test("run prints the run; --error-report prints the report text instead", async () => {
	const plain = harness();
	expect(await run(args({}), plain.io)).toBe(0);
	expect(plain.shown).toEqual([{ id: "run-1" }]);
	expect(plain.calls).toEqual(["run run-1"]);
	const report = harness();
	expect(await run(args({ errorReport: true }), report.io)).toBe(0);
	expect(report.shown).toEqual(["# Eumenes エラーレポート"]);
	expect(report.calls).toEqual(["report run-1"]);
	await expect(run(args({ positional: [] }), plain.io)).rejects.toThrow(
		"run ID required",
	);
});
