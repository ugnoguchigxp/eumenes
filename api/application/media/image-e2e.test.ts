import { expect, test } from "bun:test";
import { imageFixture, imageQuestion, imageTestPlan } from "./image.fixture";
import { musicFixture, musicQuestion } from "./music.fixture";
import {
	ask,
	assignmentAgenda,
	cancelAssignment,
	ended,
	executions,
	items,
	notes,
	plannedBy,
	reportLine,
	resources,
	until,
	works,
} from "./assignment.fixture";

const generations = (f: ReturnType<typeof imageFixture>) =>
	f.requests.filter(
		(r) => r.method === "POST" && r.path === "/v1/images/generations",
	);
const artifactValues = (model: string) => ({
	prompt: "窓辺で眠る猫の写真",
	model,
	width: 768,
	height: 768,
	seed: 42,
	format: "webp",
});
const artifactText = (values: object) =>
	`制作条件をそのまま使って画像を1枚生成してください。\n\n${JSON.stringify(values)}`;

for (const mode of [
	"success",
	"failure",
	"invalid-plan",
	"library",
	"studio",
	"fetch-failure",
] as const)
	test(`image pipeline ${mode}: assignment, plan, result and authenticated content`, async () => {
		const f = imageFixture(mode);
		const a = await assignmentAgenda({
			media: f,
			harness: { model: plannedBy({ image: f }) },
		});
		try {
			await a.start();
			await ask(a, "image.create", imageQuestion);
			await until(a, () => ended(a));
			// The user's words started one execution at its owner, and the agent's work row holds it.
			expect(executions(a)).toHaveLength(1);
			expect(works(a)).toMatchObject([
				{
					toolchain_revision_id: expect.stringMatching(
						/^toolchain:image\.create@/,
					),
				},
			]);
			expect(works(a)[0]!.execution_id).toBe(executions(a)[0]!.id);
			const records = await (
				await a.h.request("/api/images/generations?conversationId=ao")
			).json();
			expect(records).toHaveLength(1);
			const success = ["success", "library", "studio"].includes(mode);
			expect(records[0].state).toBe(success ? "completed" : "failed");
			const posts = generations(f);
			expect(posts).toHaveLength(
				["invalid-plan", "library", "studio"].includes(mode) ? 0 : 1,
			);
			if (posts[0]) {
				expect(posts[0].body).not.toHaveProperty("model");
				expect(posts[0].body).not.toHaveProperty("steps");
				expect(posts[0].body).toMatchObject({
					prompt: imageTestPlan.prompt,
					width: 121,
					height: 177,
					seed: 42,
					format: "png",
				});
			}
			expect(f.stages).toEqual(["plan"]);
			if (mode === "success") {
				// The agent reports on its own: a work report note, and a line whose chip is the image.
				await until(a, () => !!reportLine(a));
				expect(notes(a)).toHaveLength(1);
				expect(items(a)).toHaveLength(0);
				const made = await resources(a);
				expect(made.resources.map((r) => r.kind)).toContain("image");
				expect(made.messages).toContainEqual(
					expect.objectContaining({ messageId: reportLine(a)!.id }),
				);
			}
			const library = await (await a.h.request("/api/images/library")).json();
			expect(
				library.images.some((x: { id: string }) => x.id === "past-image"),
			).toBe(true);
			expect(
				(await a.h.app.request("/api/images/past-image/content")).status,
			).toBe(401);
			const content = await a.h.request("/api/images/past-image/content");
			expect(content.status).toBe(200);
			expect(content.headers.get("content-type")).toBe("image/png");
			expect(new Uint8Array(await content.arrayBuffer())).toEqual(
				new Uint8Array(f.images.get("past-image")!.bytes),
			);
			expect(
				f.requests.every((r) => r.auth === "Bearer fixture-image-secret"),
			).toBe(true);
			expect(JSON.stringify(records)).not.toContain("fixture-image-secret");
			if (mode === "fetch-failure") {
				expect(records[0].artifactId).toBe("new-image");
				expect(posts).toHaveLength(1);
			}
		} finally {
			await a.close();
		}
	}, 30_000);

test("cancelling the assignment discards a late synchronous image response and never resubmits", async () => {
	const gate = Promise.withResolvers<void>();
	const f = imageFixture("success", gate.promise);
	const a = await assignmentAgenda({
		media: f,
		harness: { model: plannedBy({ image: f }) },
	});
	try {
		await a.start();
		const { id } = await ask(a, "image.create", imageQuestion);
		await until(a, () => generations(f).length === 1);
		const { seen } = await cancelAssignment(a, id);
		expect(
			seen[1]!.filter((m) => m.role === "tool").map((m) => m.content),
		).toHaveLength(1);
		gate.resolve();
		await until(a, () => ended(a));
		// A negative check: a late result must have real time to (not) be adopted.
		await Bun.sleep(50);
		expect(executions(a)[0]).toMatchObject({ status: "cancelled" });
		expect(a.h.image!.list("ao")[0]!.state).toBe("cancelled");
		expect(a.h.image!.list("ao")[0]!.artifactId).toBeNull();
		expect(generations(f)).toHaveLength(1);
		// A stopped assignment is no open item and has no report note: the user stopped it.
		expect(items(a)).toHaveLength(0);
		expect(notes(a)).toHaveLength(0);
	} finally {
		gate.resolve();
		await a.close();
	}
}, 30_000);

test("capability revocation rejects a generated result at adoption", async () => {
	const gate = Promise.withResolvers<void>();
	const f = imageFixture("success", gate.promise);
	const a = await assignmentAgenda({
		media: f,
		harness: { model: plannedBy({ image: f }) },
	});
	try {
		await a.start();
		await ask(a, "image.create", imageQuestion);
		await until(a, () => generations(f).length === 1);
		await a.h.store.write((db) =>
			a.h.toolchain.capabilities.setEnabledInTransaction(
				db,
				"tool",
				"image.generate",
				false,
			),
		);
		gate.resolve();
		await until(a, () => a.h.image!.list("ao")[0]!.state !== "generating");
		// A late response is not adopted: the revoked toolchain's work stops, and nothing is resubmitted.
		await Bun.sleep(50);
		expect(["cancelled", "failed"]).toContain(a.h.image!.list("ao")[0]!.state);
		expect(a.h.image!.list("ao")[0]!.artifactId).toBeNull();
		expect(generations(f)).toHaveLength(1);
		expect(notes(a)).toHaveLength(0);
	} finally {
		gate.resolve();
		await a.close();
	}
}, 30_000);

test("an image assignment starts though the conversation earlier used only another toolchain", async () => {
	const image = imageFixture("success");
	const music = musicFixture("success");
	const a = await assignmentAgenda({
		media: image,
		harness: {
			model: plannedBy({ image, music }),
			musicGateway: music.gateway,
		},
		catalog: (id) =>
			id.startsWith("toolchain:image.create@") ||
			id.startsWith("toolchain:music.create@"),
	});
	try {
		await a.start();
		await ask(a, "music.create", musicQuestion);
		await until(a, () => ended(a));
		expect(a.h.music!.list("ao")).toHaveLength(1);
		await ask(a, "image.create", imageQuestion);
		await until(a, () => ended(a, 2));
		const records = await (
			await a.h.request("/api/images/generations?conversationId=ao")
		).json();
		expect(records).toHaveLength(1);
		expect(records[0].state).toBe("completed");
		// Each assignment started its own toolchain: no second track was made for the image.
		expect(image.stages).toEqual(["plan"]);
		expect(a.h.music!.list("ao")).toHaveLength(1);
		expect(generations(image)).toHaveLength(1);
		expect(works(a).map((w) => w.toolchain_revision_id.split("@")[0])).toEqual([
			"toolchain:music.create",
			"toolchain:image.create",
		]);
	} finally {
		await a.close();
	}
}, 30_000);

for (const model of ["qwen-image-2.1-turbo", "flux-3-image-klein"])
	test(`the artifact form's request carries ${model} through planning, storage and the authenticated LARM POST`, async () => {
		const f = imageFixture("success");
		const a = await assignmentAgenda({
			media: f,
			harness: { model: plannedBy({ image: f }) },
		});
		try {
			await a.start();
			const values = artifactValues(model);
			await ask(a, "image.create", artifactText(values));
			await until(a, () => ended(a));
			const record = a.h.image!.list("ao")[0]!;
			expect(record).toMatchObject({
				state: "completed",
				model,
				actualModel: model,
			});
			const posts = generations(f);
			expect(posts).toHaveLength(1);
			expect(posts[0]!.body).toEqual(values);
			expect(posts[0]!.auth).toBe("Bearer fixture-image-secret");
		} finally {
			await a.close();
		}
	}, 30_000);

for (const [status, code] of [
	[503, "image_model_unavailable"],
	[409, "media_variant_busy"],
	[400, "invalid_model"],
] as const)
	test(`artifact image form ${code} settles as failed with a single POST and no model switch`, async () => {
		const f = imageFixture("success", undefined, undefined, { status, code });
		const a = await assignmentAgenda({
			media: f,
			harness: { model: plannedBy({ image: f }) },
		});
		try {
			await a.start();
			const values = artifactValues("flux-3-image-klein");
			await ask(a, "image.create", artifactText(values));
			await until(a, () => ended(a));
			expect(a.h.image!.list("ao")[0]).toMatchObject({
				state: "failed",
				model: values.model,
				artifactId: null,
				errorCode: status === 400 ? "larm_http_400" : code,
			});
			const posts = generations(f);
			expect(posts).toHaveLength(1);
			expect(posts[0]!.body).toEqual(values);
		} finally {
			await a.close();
		}
	}, 30_000);

test("LARM's free-memory refusal puts the image into a wait: connection released, one POST, assignment kept open, cancel stops it", async () => {
	const f = imageFixture("success", undefined, undefined, {
		status: 503,
		code: "resource_exhausted",
		resource: "memory",
	});
	const a = await assignmentAgenda({
		media: f,
		harness: { model: plannedBy({ image: f }) },
	});
	try {
		await a.start();
		const { id } = await ask(a, "image.create", imageQuestion);
		await until(
			a,
			() => a.h.image!.list("ao")[0]?.phase === "waiting_capacity",
		);
		const record = a.h.image!.list("ao")[0]!;
		expect(record).toMatchObject({ state: "generating" });
		expect(record.capacityWait?.count).toBe(1);
		expect(generations(f)).toHaveLength(1);
		// The connection was released before the wait began.
		expect(
			f.requests.some(
				(r) =>
					r.method === "DELETE" &&
					r.path === "/v1/agent-connections/image-connection",
			),
		).toBe(true);
		// The assignment stays open while the image waits: still an item of the agent, not ended at its owner.
		expect(items(a)).toHaveLength(1);
		expect(ended(a)).toBe(false);
		// Cancelling the assignment cancels the waiting job; nothing is sent afterwards.
		await cancelAssignment(a, id);
		await until(a, () => a.h.image!.list("ao")[0]!.state === "cancelled");
		await Bun.sleep(50);
		expect(generations(f)).toHaveLength(1);
	} finally {
		await a.close();
	}
}, 30_000);
