import { expect, test } from "bun:test";
import { hash, type PipelineDefinition } from "../../capabilities";
import { waitFor } from "../../../infrastructure/wait-for";
import { done, setup } from "./task-execution-harness";

test("resolved materials exceeding the whole child input budget stop without launching the next child", async () => {
	const h = await setup([], done(), true);
	const definition: PipelineDefinition = {
		formatVersion: 1,
		id: "material-limit",
		title: "資料の容量",
		summary: "資料を順に渡す",
		useWhen: ["資料を処理したい", "資料を次に渡したい", "資料の手順"],
		avoidWhen: [],
		inputs: {},
		steps: [
			{
				id: "first",
				kind: "toolchain",
				title: "最初",
				toolchain: "operate",
				request: "最初の処理",
			},
			{
				id: "second",
				kind: "toolchain",
				title: "次",
				toolchain: "operate",
				request: "次の処理" + "R".repeat(1900),
				materials: [{ kind: "text", text: "A".repeat(16000) }],
			},
		],
	};
	h.port.pipelineInTransaction = () => ({
		toolchainRevisionId: "toolchain:pipeline.material-limit@1",
		bindingRevisionId: "binding:pipeline.material-limit@1",
		definition,
		runMs: 300000,
	});
	h.port.stepToolchainInTransaction = () => "toolchain:operate@1";
	const source = {
		...h.source,
		request: "X".repeat(7900),
		digest: hash("X".repeat(7900)),
	};
	const started = await h.store.write((db) =>
		h.runtime.startPipelineInTransaction(db, {
			toolchainRevisionId: "toolchain:pipeline.material-limit@1",
			source,
			inputs: {},
		}),
	);
	h.run();
	await waitFor(() => h.get(started.id).status === "partial");
	expect(h.children).toHaveLength(1);
	expect(h.get(started.id).result).toMatchObject({
		code: "execution_input_capacity",
		fulfilled: ["最初"],
		missing: ["次"],
	});
});
