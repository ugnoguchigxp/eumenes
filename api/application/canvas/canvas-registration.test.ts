import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCapabilities, migrations } from "../../domains/capabilities";
import { openStore } from "../../infrastructure/sqlite";
import { canonicalJson, sha256Hex } from "../../infrastructure/digest";
import { offlineBundleHost } from "../toolchain/toolchain-adapters";
import { describeCanvasAdapter } from "./adapter";

const bundle = () =>
	JSON.parse(
		readFileSync(
			new URL(
				"../../domains/capabilities/bundles/canvas-app.bundle.json",
				import.meta.url,
			),
			"utf8",
		),
	);
const published = new Map([
	[
		"profile:canvas.app@1",
		"1c3747a1f98e2022debb0fcb9aedc3581dd9a7dd6201c3369a8549473268feee",
	],
	[
		"skill:canvas.app@1",
		"4cfb7d731ff8f957712f78be5ea25b086e7b92e4bc0f0daad1bc2e4cf89c7955",
	],
	[
		"tool:canvas.produce@1",
		"5e6b00c7dc8d3d198c0db41d8c8fe17c2a4c0a1bab99c6097bca7d0761d83477",
	],
	[
		"package:canvas.app@1",
		"0f4229dc5cfd2bbfb356a3ab496024f88dc37c52b5ec240d7d16d2a7b366804b",
	],
	[
		"toolchain:canvas.app@1",
		"25fcce3ca3a1793c5aeed137f9cc5a6d24572e2a4d9c49da86ebec7a4a0f5921",
	],
	[
		"binding:canvas.app@1",
		"f6648f9dbada8462302548594fc710717f8adac328b18569e870e5c6094147b8",
	],
	[
		"artifact:canvas.workspace@1",
		"6ae38fae32f00b0b6e94e569650f965f3fff68f7b42f206555a1d625210debe3",
	],
]);

test("公開済みv1の定義・binding・artifactは変更しない", () => {
	const data = bundle();
	const checked: string[] = [];
	for (const document of [
		...data.definitions,
		...data.bindings,
		...data.artifacts,
	]) {
		const id = `${document.kind}:${document.id}@${document.revision}`;
		if (published.has(id)) {
			expect(
				sha256Hex(
					canonicalJson(document, {
						omitUndefined: true,
						keyOrder: "codeUnit",
					}),
				),
			).toBe(published.get(id)!);
			checked.push(id);
		}
	}
	expect(checked.sort()).toEqual([...published.keys()].sort());
});

test.each([false, true])(
	"Canvasの新規DB・旧版seed済みDBへ新契約を登録でき、再seedで変化しない（旧版=%s）",
	async (legacy) => {
		const dir = mkdtempSync(join(tmpdir(), "canvas-registration-"));
		const store = openStore(join(dir, "fixture.db"), migrations);
		const capabilities = createCapabilities(store, new Set(["canvas"]), {
			bundleHost: offlineBundleHost,
		});
		try {
			if (legacy) {
				const prior = bundle();
				prior.definitions = prior.definitions.filter(
					(d: { kind: string; id: string; revision: number }) =>
						published.has(`${d.kind}:${d.id}@${d.revision}`),
				);
				prior.bindings = prior.bindings.filter(
					(d: { id: string; revision: number }) =>
						d.id === "canvas.app" && d.revision === 1,
				);
				const imported = await store.write((tx) =>
					capabilities.importBundleInTransaction(
						tx,
						prior,
						offlineBundleHost(),
						{ dryRun: false },
					),
				);
				expect(imported.issues).toEqual([]);
			}
			await capabilities.seed();
			const revisions = store.read((tx) =>
				capabilities
					.toolchainsInTransaction(tx)
					.filter((d) => ["canvas.app", "canvas.find"].includes(d.id))
					.map((d) => d.revisionId)
					.sort(),
			);
			expect(revisions).toEqual([
				"toolchain:canvas.app@2",
				"toolchain:canvas.find@1",
			]);
			const binding = store.read((tx) =>
				capabilities.toolchainBindingInTransaction(
					tx,
					"toolchain:canvas.app@2",
				),
			)!;
			expect(binding.binding.document.tools).toMatchObject([
				{
					inputSchemaRef: "builtin:canvasProduceV2",
					operationId: "canvas.produce.v2",
					conversationRequestField: "request",
				},
			]);
			expect(
				offlineBundleHost().adapters.get("adapter:canvas@1")?.operations,
			).toEqual(describeCanvasAdapter().operations);
			await capabilities.seed();
			expect(
				store.read((tx) =>
					capabilities
						.toolchainsInTransaction(tx)
						.filter((d) => ["canvas.app", "canvas.find"].includes(d.id))
						.map((d) => d.revisionId)
						.sort(),
				),
			).toEqual(revisions);
		} finally {
			await capabilities.close();
			await store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	},
);
