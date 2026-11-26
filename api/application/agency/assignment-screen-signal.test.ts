import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { hash } from "../../domains/capabilities";
import { waitFor } from "../../infrastructure/wait-for";
import { imageFixture } from "../media/image.fixture";
import {
	agendaFixture,
	composeSay,
	planNothing,
	replyWith,
	type CallKind,
} from "./always-on.fixture";

/**
 * An assignment the user asked a toolchain for tells the Web which registered screen to open (spec
 * toolchain-assignment-as-research-2026-11-25.md section 13): the status carries `{ assignment, adapterRef }` while the
 * assignment runs. A screen form's assignment and the agent's own research carry none.
 */
type Fixture = Awaited<ReturnType<typeof agendaFixture>>;

const ADAPTER = "adapter:fixture.screen@1";

const said = (kind: CallKind) =>
	kind === "compose" ? composeSay("できました。") : undefined;

async function userWords(f: Fixture, text: string) {
	const run = await f.h.dialogue.submit({
		requestId: crypto.randomUUID(),
		conversationId: "ao",
		text,
	});
	return {
		conversationId: "ao",
		messageId: run.inputMessageId,
		runId: run.id,
		request: text,
		digest: hash(text),
	};
}

function assign(
	f: Fixture,
	source: Awaited<ReturnType<typeof userWords>>,
	input: { adapterRef?: string; screenForm?: boolean },
) {
	const found = f.h.store
		.read((db) => f.port.catalogInTransaction(db))
		.find((c) => c.revisionId.startsWith("toolchain:image.create@"))!;
	return f.host.dialoguePort.assign!({
		toolchainId: "image.create",
		revisionId: found.revisionId,
		title: found.title,
		request: source.request,
		references: [],
		source,
		...(input.adapterRef ? { adapterRef: input.adapterRef } : {}),
		...(input.screenForm
			? { userMessage: { id: source.messageId, text: source.request } }
			: {}),
	});
}

test("the status lists a user assignment with its adapter once its toolchain took the work, still for a while after a quick one ended, then not", async () => {
	const gate = Promise.withResolvers<void>();
	const f = await agendaFixture({
		media: imageFixture("success", gate.promise),
		script: said,
	});
	try {
		await f.start();
		expect(f.host.status("ao").assignments).toEqual([]);
		const source = await userWords(f, "夕焼けの海の絵を描いて");
		const accepted = assign(f, source, { adapterRef: ADAPTER });
		expect(accepted).toMatchObject({ status: "accepted" });
		const id = (accepted as { id: string }).id;
		// Accepted is not started: nothing opens before the toolchain has the work.
		expect(f.host.status("ao").assignments).toEqual([]);
		await waitFor(async () => {
			await f.advance(1000);
			return f.host.status("ao").assignments.length === 1;
		});
		const startedAt = f.host.status("ao").assignments[0]!.at;
		expect(f.host.status("ao").assignments).toEqual([
			{ assignment: id, adapterRef: ADAPTER, at: startedAt },
		]);
		gate.resolve();
		await waitFor(async () => {
			await f.advance(1000);
			return f.host.inspect("ao")!.snapshot.notes.length === 1;
		});
		// A quick assignment that already ended still opens its screen when the Web reads late.
		expect(f.host.status("ao").assignments).toEqual([
			{ assignment: id, adapterRef: ADAPTER, at: startedAt },
		]);
		await f.advance(10 * 60_000);
		expect(f.host.status("ao").assignments).toEqual([]);
	} finally {
		gate.resolve();
		await f.close();
	}
}, 30_000);

test("an assignment whose start is refused opens no screen", async () => {
	const f = await agendaFixture({
		media: imageFixture("success"),
		script: said,
	});
	try {
		await f.start();
		const source = await userWords(f, "夕焼けの海の絵を描いて");
		const found = f.h.store
			.read((db) => f.port.catalogInTransaction(db))
			.find((c) => c.revisionId.startsWith("toolchain:image.create@"))!;
		// A capability that is not in the catalog: the start is refused.
		expect(
			f.host.dialoguePort.assign!({
				toolchainId: "image.create",
				revisionId: "toolchain:image.create@0",
				title: found.title,
				request: source.request,
				references: [],
				source,
				adapterRef: ADAPTER,
			}),
		).toMatchObject({ status: "accepted" });
		await f.advance(1000);
		await f.advance(1000);
		await waitFor(() =>
			f.host.inspect("ao")!.snapshot.agent.items.every((i) => !i.delegatedTo),
		);
		expect(f.host.status("ao").assignments).toEqual([]);
	} finally {
		await f.close();
	}
}, 30_000);

test("an assignment without an adapter (no binding) and a screen form's assignment are not in the status", async () => {
	const gate = Promise.withResolvers<void>();
	const f = await agendaFixture({
		media: imageFixture("success", gate.promise),
		script: said,
	});
	try {
		await f.start();
		const source = await userWords(f, "夕焼けの海の絵を描いて");
		expect(assign(f, source, {})).toMatchObject({ status: "accepted" });
		expect(f.host.status("ao").assignments).toEqual([]);
	} finally {
		gate.resolve();
		await f.close();
	}
}, 30_000);

test("a screen form's assignment is not in the status even when its adapter is known: that screen is open already", async () => {
	const gate = Promise.withResolvers<void>();
	const f = await agendaFixture({
		media: imageFixture("success", gate.promise),
		script: said,
	});
	try {
		await f.start();
		const source = await userWords(f, "夕焼けの海の絵を描いて");
		expect(
			assign(f, source, { adapterRef: ADAPTER, screenForm: true }),
		).toMatchObject({ status: "accepted" });
		expect(f.host.status("ao").assignments).toEqual([]);
	} finally {
		gate.resolve();
		await f.close();
	}
}, 30_000);

test("the agent's own research is not in the status", async () => {
	const f = await agendaFixture({
		media: imageFixture("success"),
		script: (kind: CallKind) => (kind === "plan" ? planNothing() : undefined),
	});
	try {
		await f.start();
		await f.user("user-a");
		await replyWith(f, [
			{
				name: "start_preparation",
				arguments: { request: "fixture asked research", askedByUser: true },
			},
		]);
		await f.advance(1000);
		await f.advance(1000);
		await waitFor(
			() => f.h.toolchain.agents.executions.list("ao").length === 1,
		);
		expect(f.host.status("ao").assignments).toEqual([]);
	} finally {
		await f.close();
	}
}, 30_000);

test("Claude Code's binding adapter has no registered screen, so its assignment opens nothing (its screen opens through the terminals hook)", () => {
	const claude = "adapter:claude-code-task@1";
	const dir = new URL("../../domains/capabilities/bundles/", import.meta.url);
	const bundles = readdirSync(dir.pathname).filter((name) =>
		name.endsWith(".bundle.json"),
	);
	const screens = bundles.flatMap((name) => {
		const bundle = JSON.parse(readFileSync(`${dir.pathname}${name}`, "utf8"));
		return (bundle.artifacts ?? []).filter(
			(artifact: { sourceBindings?: Array<{ adapterRef: string }> }) =>
				artifact.sourceBindings?.some((b) => b.adapterRef === claude),
		);
	});
	expect(bundles.length).toBeGreaterThan(0);
	expect(screens).toEqual([]);
});
