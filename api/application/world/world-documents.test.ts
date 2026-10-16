import { expect, test } from "bun:test";
import { boot, invoke, SCOPE, type Packet } from "./world-research.fixture";
import { sha256Hex } from "../../infrastructure/digest";

const content =
	"搬入規程の有効期間は2026年10月1日以降。西工房のみ対象。測定結果はこの資料に含まれない。";
const seed = {
	id: "collected-1",
	revision: "seed-1",
	title: "搬入規程",
	collection: "test",
	manifestDigest: "a".repeat(64),
	content,
	digest: `sha256:${sha256Hex(content)}`,
};
const report = (packet: Packet) => ({
	action: "finish",
	report: {
		outcome: "answered",
		summary: "収集資料では西工房が対象です。",
		claims: [
			{
				text: "搬入規程では西工房が対象と記載されています。",
				evidence: [
					packet.observations
						.flatMap((o) => o.excerpts)
						.find((e) => e.quote.includes("西工房"))!.reference,
				],
			},
		],
		limitations: ["測定結果は確認できていません。"],
	},
});
const search = () => invoke("world.documents", { query: "搬入規程" });
const read = (packet: Packet) => {
	const notes = packet.operations.at(-1)!.notes as {
		documents: { id: string }[];
	};
	expect(notes.documents).toHaveLength(1);
	return invoke("world.documents", { documentId: notes.documents[0]!.id });
};

test("collected seed reaches the existing worker and report without becoming a personal claim", async () => {
	const h = await boot([search, read, report]);
	await h.world.documents.import(SCOPE, seed);
	const { done } = await h.ask("収集資料から搬入規程の対象を調べて");
	expect(done?.status).toBe("completed");
	expect(h.packets[2]!.observations[0]!.origin).toBe("collected_document");
	const parent = h.parentMessages.find((m) => m.includes("world_document"))!;
	expect(parent).toBeDefined();
	expect(parent).toContain("搬入規程");
	expect(parent).toContain("利用者の発言や本人についての記憶ではありません");
	expect(parent).not.toContain("collected-1");
	expect(parent).not.toContain("sourceRef");
	expect(h.workerMessages.join("")).toContain("観測未提供");
});

test("withdrawn collected evidence cannot be adopted after it was read", async () => {
	const h = await boot([
		search,
		read,
		async (packet) => {
			await h.world.documents.withdraw(SCOPE, seed.id);
			return report(packet);
		},
	]);
	await h.world.documents.import(SCOPE, seed);
	await h.ask("収集資料から搬入規程の対象を調べて");
	expect(h.packets).toHaveLength(3);
	const error = h.store.read((db) =>
		db.query("SELECT error_code FROM agent_tasks WHERE kind='worker'").get(),
	) as { error_code: string };
	expect(error.error_code).toBe("evidence_invalidated");
	const rows = h.store.read((db) =>
		db.query("SELECT report_json FROM agent_reports").all(),
	);
	expect(rows).toHaveLength(0);
	expect(h.parentMessages.join("")).not.toContain("world_document");
});
