import { expect, test } from "bun:test";
import type {
	RouteDecision as PackageDecision,
	RouteCandidate as PackageCandidate,
} from "eumenes_router";
import { hostDecision } from "../service/routed-package";
import { IMAGE } from "./generation.fixture";
import type { RouteCandidate } from "../service/routed-route";

test("pipeline mapping preserves the requirement that every part can be executed by the host", () => {
	const tool: RouteCandidate = {
		id: IMAGE.id,
		kind: "toolchain",
		passage: "画像",
		card: IMAGE,
		choice: { id: IMAGE.id, title: IMAGE.title },
	};
	const pipeline: RouteCandidate = { ...tool, id: "pipeline.execute" };
	const decision: PackageDecision = {
		row: 9,
		to: "pipeline",
		steps: [
			{
				text: "画像を作って",
				candidate: tool,
				decision: { row: 2, to: "run", candidate: tool, announce: "fixed" },
				after: [],
			},
		],
	};
	expect(hostDecision(decision, () => tool, pipeline)).toMatchObject({
		to: "run",
		candidate: pipeline,
	});
	expect(hostDecision(decision, () => null, pipeline)).toBeNull();
	const pending: PackageCandidate = {
		id: "c1.approve",
		kind: "pending",
		operation: "approve",
		confirmation: "c1",
		toolchain: IMAGE.id,
		passage: "承認する",
	};
	const control: PackageDecision = {
		...decision,
		steps: [
			{
				text: "はい",
				candidate: pending,
				decision: { row: 5, to: "run", candidate: pending, announce: "none" },
				after: [],
			},
		],
	};
	expect(hostDecision(control, () => tool, pipeline)).toBeNull();
});
