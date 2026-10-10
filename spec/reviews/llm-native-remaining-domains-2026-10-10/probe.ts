// Audit-only reproduction. All text is synthetic; every DB is temporary.
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLife } from "../../../api/domains/world/test/lifecycle-fixture";
import {
	SCOPE,
	addMessage,
	entityOp,
} from "../../../api/domains/world/test/fixture";
import {
	rigFor,
	drain,
	candidate,
	modelOutput,
	mirrorRows,
	inboxRows,
	assertionRows,
	SERVICE_ENTITY,
} from "../../../api/domains/world/test/extraction-fixture";
import { openStore } from "../../../api/infrastructure/sqlite";
import {
	createGoalsService,
	migration,
	operationMigration,
} from "../../../api/domains/goals";
import { evaluateAdmission } from "eumenes-memory";
import { sha256Hex } from "../../../api/infrastructure/digest";
import { sameSemanticKey } from "../../../node_modules/eumenes-memory/src/domains/state/service/semantic-key";

const result: Record<string, unknown> = {};
const life = await openLife();
try {
	assert.equal((await life.lifecycle.recoverWorld()).status, "open");
	assert.equal((await life.world.apply(entityOp())).status, "applied");
	const text = "音声サービスは利用できます。";
	await addMessage(life, "audit-held", text);
	await life.lifecycle.consumeSourceChanges(SCOPE);
	let entities: unknown[] = [];
	const rig = rigFor(
		life,
		(call) => {
			const id = JSON.parse(call.messages[1]!.content).utterances[0]
				.utteranceId;
			return modelOutput(
				candidate(text, id, {
					subject: { kind: "alias", text: "音声サービス" },
				}),
			);
		},
		{ entities: () => entities },
	);
	assert.equal((await drain(rig)).length, 1);
	const report = rig.reports.at(-1) as { held: number; accepted: number };
	assert.equal(report.held, 1);
	assert.equal(report.accepted, 0);
	assert.equal(mirrorRows(life)[0]!.state, "applied");
	assert.equal(inboxRows(life)[0]!.status, "applied");
	entities = [SERVICE_ENTITY];
	const afterData = await rig.extraction.schedule(SCOPE);
	assert.equal(afterData.status, "idle");
	result.worldHeld = {
		report,
		hostState: mirrorRows(life)[0]!.state,
		inboxState: inboxRows(life)[0]!.status,
		afterEntityData: afterData,
		claims: assertionRows(life).length,
		modelCalls: rig.inference.state.executed,
	};
} finally {
	await life.cleanup();
}

const dir = mkdtempSync(join(tmpdir(), "eumenes-audit-goals-"));
const store = openStore(join(dir, "audit.sqlite3"), [
	migration,
	operationMigration,
]);
try {
	const goals = createGoalsService(store);
	const access = { principal: "audit", scopeKeys: ["audit"] };
	const base = {
		scopeKey: "audit",
		source: { namespace: "fixture", kind: "document", id: "same-source" },
	};
	const a = await goals.propose(access, {
		...base,
		desiredState: "保管コードはUS",
		priority: 10,
		operationKey: "a",
	});
	const b = await goals.propose(access, {
		...base,
		desiredState: "保管コードはus",
		priority: 90,
		operationKey: "b",
	});
	assert.equal(a.id, b.id);
	assert.equal(b.desiredState, "保管コードはUS");
	assert.equal(b.priority, 10);
	result.goalNormalization = {
		sameId: a.id === b.id,
		secondText: b.desiredState,
		secondPriority: b.priority,
		proposals: goals.proposals(access).length,
	};
} finally {
	await store.close();
	rmSync(dir, { recursive: true, force: true });
}

function admission(content: string, quote: string) {
	const digest = sha256Hex(content);
	const startByte = Buffer.byteLength(content.slice(0, content.indexOf(quote)));
	const source = {
		namespace: "fixture",
		kind: "message",
		id: "m",
		representation: "text",
		revision: `sha256:${digest}`,
		digest,
		principal: "audit",
		scopeKey: "audit",
		status: "available" as const,
		role: "user" as const,
		content,
		ordinal: 1,
	};
	const ref = {
		namespace: source.namespace,
		kind: source.kind,
		id: source.id,
		representation: source.representation,
		revision: source.revision,
		digest,
		range: { startByte, endByte: startByte + Buffer.byteLength(quote) },
	};
	return evaluateAdmission({
		candidate: {
			kind: "preference",
			subject: "self",
			semanticKey: "book",
			value: { text: quote, polarity: "affirmed" },
			modality: "asserted",
			temporal: "current",
			evidence: [{ source: ref, quote }],
		},
		principal: "audit",
		scopeKey: "audit",
		inputSources: [source],
		currentSources: [source],
		activeForKey: null,
		policy: {
			preference: "auto_admit",
			personal_fact: "auto_admit",
			constraint: "auto_admit",
			habit: "auto_admit",
			other_person_note: "user_confirm",
		},
	});
}
const plain = admission("私は羅針盤が好きです。", "羅針盤");
const title = admission("私は『羅針盤』が好きです。", "羅針盤");
assert.equal(plain.decision, "admitted");
assert.deepEqual(title, {
	decision: "pending_user",
	reasonCode: "MODALITY_QUOTED",
});
result.memoryDormantQuote = { plain, title };
const dictionary = {
	version: "fixture-1",
	predicates: [{ id: "editor.primary", aliases: ["主に使うエディタ"] }],
};
result.memoryExactKeyLookup = {
	registered: sameSemanticKey("主に使うエディタ", "editor.primary", dictionary),
	unregistered: sameSemanticKey(
		"いつものエディタ",
		"editor.primary",
		dictionary,
	),
};
console.log(JSON.stringify(result, null, 2));
