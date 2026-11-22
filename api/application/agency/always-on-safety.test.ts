import { expect, test } from "bun:test";
import { defaultLimits } from "eumenes-agency";
import { autonomousActionSource } from "../../domains/dialogue";
import type { Settings } from "../../domains/settings";
import { settle, waitFor } from "../../infrastructure/wait-for";
import { imageFixture } from "../media/image.fixture";
import { agendaFixture, planNothing, type CallKind } from "./always-on.fixture";
import { createAlwaysOnHost } from "./always-on-host";
import { createRebuildingAgencyHost } from "./rebuilding-host";

const planPicture = {
	add: [
		{
			kind: "research",
			text: "fixture preparation",
			refs: ["user-a"],
			value: 5,
			reason: "fixture",
			topic: "picture",
		},
	],
	drop: [],
	focus: "picture",
};

/** An image research whose result is held at the gate: the work is out, and its result comes at `release`. */
async function gatedResearch() {
	const gate = Promise.withResolvers<void>();
	const media = imageFixture("success", gate.promise);
	let planned = false;
	const f = await agendaFixture({
		media,
		script: (kind: CallKind, request) => {
			if (kind === "plan" && !planned && request.prompt.includes("user-a")) {
				planned = true;
				return planPicture;
			}
			return kind === "plan" ? planNothing() : undefined;
		},
	});
	const works = () =>
		f.h.store.read((db) =>
			db
				.query(
					"SELECT root_id,execution_id,returned,revoked FROM dialogue_agency_work",
				)
				.all(),
		) as Array<{
			root_id: string;
			execution_id: string | null;
			returned: number;
			revoked: number;
		}>;
	/** The research is out: its execution runs and the image service holds its answer. */
	const out = async () => {
		await f.user("user-a");
		await f.advance(1000);
		await waitFor(() => !!works()[0]?.execution_id);
		await waitFor(() =>
			media.requests.some((r) => r.path === "/v1/images/generations"),
		);
	};
	const agencyWords = () =>
		f.h.conversation
			.get("ao")
			.messages.filter((m) => m.id.startsWith("agency:"));
	return {
		f,
		works,
		out,
		agencyWords,
		release: () => gate.resolve(),
		close: async () => {
			gate.resolve();
			await f.close();
		},
	};
}

async function change(
	f: Awaited<ReturnType<typeof agendaFixture>>,
	mutate: (settings: Settings) => void,
) {
	const settings = f.h.settings.get();
	mutate(settings);
	await f.h.settings.apply({
		requestId: crypto.randomUUID(),
		expectedRevision: settings.revision,
		settings,
		keys: [],
	});
	await settle();
}

for (const stop of ["settings", "forget", "cancel", "capability"] as const) {
	test(`${stop} stops a research in flight, and its late result is not adopted: no note, no resource, no speech`, async () => {
		const r = await gatedResearch();
		const { f } = r;
		try {
			await f.start();
			await r.out();
			const rootId = r.works()[0]!.root_id;
			const executionId = r.works()[0]!.execution_id!;
			const source = f.h.store.read((db) =>
				autonomousActionSource(db, rootId, Date.now()),
			)!;
			expect(source.origin).toBe("autonomous");
			expect(
				f.h.store.read((db) =>
					f.h.executionPort!.validSourceInTransaction(db, source),
				),
			).toBe(true);
			if (stop === "settings")
				await change(f, (s) => {
					s.agency.actions = {
						enabled: false,
						maxConcurrent: 1,
						dailyLimit: 3,
					};
				});
			else if (stop === "capability")
				await f.h.store.write((db) =>
					f.h.toolchain.capabilities.setEnabledInTransaction(
						db,
						"toolchain",
						"image.create",
						false,
					),
				);
			else if (stop === "forget")
				await f.h.memory!.forget({
					conversationId: "ao",
					messageIds: ["user-a"],
					itemIds: [],
				});
			else
				await f.h.store.write((db) => f.port.cancelInTransaction(db, rootId));
			expect(
				f.h.store.read((db) =>
					f.h.executionPort!.validSourceInTransaction(db, source),
				),
			).toBe(false);
			r.release();
			await settle();
			await waitFor(
				() =>
					!["queued", "deciding", "waiting_child"].includes(
						f.h.toolchain.agents.executions.get(executionId)?.status ?? "",
					),
			);
			for (let i = 0; i < 6; i++) await f.advance(15_000);
			expect(f.h.toolchain.agents.executions.get(executionId)?.status).not.toBe(
				"completed",
			);
			expect(f.h.dialogue.conversationResources("ao").resources).toHaveLength(
				0,
			);
			expect(f.host.inspect("ao")?.snapshot.notes ?? []).toHaveLength(0);
			expect(r.agencyWords()).toHaveLength(0);
			expect(f.documents.started).toHaveLength(0);
		} finally {
			await r.close();
		}
	}, 30_000);
}

test("a capability that needs approval cannot be started from the agenda, with or without a ticket", async () => {
	const f = await agendaFixture();
	try {
		await f.start();
		await f.user("user-a");
		const card = f.h.store.read((db) =>
			f.port.catalogInTransaction(db).find((c) => c.requiresApproval),
		)!;
		expect(card).toBeDefined();
		await expect(
			f.h.store.write((db) =>
				f.port.startInTransaction(db, {
					rootId: "forged",
					conversationId: "ao",
					epoch: f.port.epochInTransaction(db, "ao"),
					ticketId: "invented",
					revisionId: card.revisionId,
					question: "fixture question",
					deadline: Date.now() + 30_000,
					sourceRefs: [],
					outboundIntervalMs: defaultLimits.outboundIntervalMs,
				}),
			),
		).rejects.toThrow("agency_approval_required");
		// The agent's own research is never handed to such a capability either.
		for (let i = 0; i < 3; i++) await f.advance(1000);
		expect(
			f.h.store.read((db) =>
				db.query("SELECT 1 FROM dialogue_agency_work").all(),
			),
		).toHaveLength(0);
		expect(f.h.toolchain.agents.executions.list("ao")).toHaveLength(0);
	} finally {
		await f.close();
	}
});

/** The server's host over a held research: `made` counts how often the host was made. */
async function rebuilding() {
	const r = await gatedResearch();
	let made = 0;
	const host = createRebuildingAgencyHost(r.f.deps, (deps) => {
		made++;
		return createAlwaysOnHost(deps);
	});
	await host.recover();
	host.start();
	await host.attend("ao");
	return { ...r, host, made: () => made };
}

test("a change of a setting the host does not read leaves a research in flight adopted", async () => {
	const r = await rebuilding();
	const { f, host } = r;
	try {
		await r.out();
		await change(f, (s) => {
			s.general.reasoningEffort = "high";
		});
		await change(f, (s) => {
			s.general.theme = "dark";
		});
		expect(r.made()).toBe(1);
		r.release();
		await waitFor(async () => {
			await f.advance(1000);
			return host.inspect("ao")!.snapshot.notes.length === 1;
		});
		expect(r.works()[0]).toMatchObject({ returned: 1, revoked: 0 });
		expect(host.inspect("ao")!.snapshot.tickets).toHaveLength(0);
	} finally {
		await host.close();
		await r.close();
	}
}, 30_000);

test("a change of a setting the host reads makes the next host, which revokes the record: the research in flight is not adopted", async () => {
	const r = await rebuilding();
	const { f, host } = r;
	try {
		await r.out();
		const executionId = r.works()[0]!.execution_id!;
		await change(f, (s) => {
			s.general.persona = "sage";
		});
		await waitFor(() => r.made() === 2);
		await waitFor(() => r.works()[0]!.revoked === 1);
		r.release();
		await settle();
		await waitFor(
			() =>
				!["queued", "deciding", "waiting_child"].includes(
					f.h.toolchain.agents.executions.get(executionId)?.status ?? "",
				),
		);
		await host.attend("ao");
		for (let i = 0; i < 6; i++) await f.advance(15_000);
		expect(host.inspect("ao")?.snapshot.notes ?? []).toHaveLength(0);
		expect(f.h.dialogue.conversationResources("ao").resources).toHaveLength(0);
		expect(r.agencyWords()).toHaveLength(0);
		expect(f.h.toolchain.agents.executions.get(executionId)?.status).not.toBe(
			"completed",
		);
	} finally {
		await host.close();
		await r.close();
	}
}, 30_000);
