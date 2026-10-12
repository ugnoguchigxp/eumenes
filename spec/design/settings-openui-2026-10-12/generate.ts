/** Design assets only. Uses the existing authenticated backend and saved LARM settings. */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createClient } from "../../../client";
import { readApiToken } from "../../../api/infrastructure/auth-config";

const directory = import.meta.dir;
const client = createClient("http://127.0.0.1:8787", readApiToken(process.env));
const screens = JSON.parse(
	await readFile(resolve(directory, "screens.json"), "utf8"),
) as {
	id: string;
	title: string;
	description: string;
}[];
const common =
	"Create a polished high-fidelity flat desktop UI design mockup, 1024x768. Japanese Eumenes AI assistant. Match this established design system: charcoal background #181a20, dark gray card surfaces #20242d, thin subtle borders #373d48, warm white text, secondary gray text, restrained blue #5279ee primary actions. Clean Japanese sans-serif typography, readable short Japanese labels, comfortable spacing, compact practical controls. No gradients, illustration, photorealistic objects, decorative icons, huge headlines, or marketing text. Show a narrow quiet conversation column on the left and the main OpenUI settings artifact occupying the right 70 percent, with simple artifact tabs at top and close button. No full settings navigation sidebar. Use only the specified supported controls and the exact short labels provided. A design proposal, not a screenshot of real saved values.";
const manifestPath = resolve(directory, "generation-manifest.json");
type Entry = {
	id: string;
	title: string;
	requestKey: string;
	runId?: string;
	status: string;
	file?: string;
	error?: string;
	model?: string;
};
let manifest: Entry[] = [];
try {
	manifest = JSON.parse(await readFile(manifestPath, "utf8"));
} catch (error) {
	if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
const selected = process.argv.slice(2);
if (!selected.includes("--generate"))
	throw new Error(
		"Explicit --generate is required; this starts LARM image generation.",
	);
const only = selected.filter((x) => x !== "--generate");
await mkdir(directory, { recursive: true });
const persist = () =>
	writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
for (const screen of screens.filter(
	(s) => !only.length || only.includes(s.id),
)) {
	let entry = manifest.find((e) => e.id === screen.id);
	if (entry?.status === "saved") continue;
	if (entry && !entry.runId)
		throw new Error(
			`Unknown POST outcome for ${screen.id}; reconcile its requestKey before another generation.`,
		);
	if (!entry) {
		const catalog = await client.serviceCatalog();
		if (catalog.stale)
			throw new Error(
				"Catalog is stale; refresh explicitly before generating.",
			);
		const target = catalog.targets.find(
			(t) =>
				t.kind === "image" && t.model === "qwen-image-2.1-turbo" && t.testable,
		);
		if (!target)
			throw new Error("Saved LARM catalog has no ready Qwen image target.");
		entry = {
			id: screen.id,
			title: screen.title,
			requestKey: crypto.randomUUID(),
			status: "submitting",
		};
		manifest.push(entry);
		await persist();
		const run = await client.startServiceTest({
			targetId: target.id,
			revision: catalog.revision,
			requestKey: entry.requestKey,
			input: {
				text: common + "\nScreen: " + screen.description,
				width: 1024,
				height: 768,
				format: "png",
				seed: 42,
			},
		});
		entry.runId = run.id;
		entry.status = run.status;
		entry.model = run.model;
		await persist();
	}
	console.log(
		JSON.stringify({
			screen: entry.id,
			status: entry.status,
			runId: entry.runId,
		}),
	);
	let run = (await client.serviceRuns()).find((r) => r.id === entry.runId);
	const deadline = Date.now() + 16 * 60_000;
	while (run?.status === "running" && Date.now() < deadline) {
		await Bun.sleep(2500);
		run = (await client.serviceRuns()).find((r) => r.id === entry!.runId);
	}
	if (!run)
		throw new Error(
			`Run ${entry.runId} is unavailable; do not resubmit automatically.`,
		);
	entry.status = run.status;
	if (run.status !== "succeeded") {
		entry.error = run.error ?? run.phase;
		await persist();
		throw new Error(`${screen.id}: ${entry.error}`);
	}
	const blob = await client.serviceArtifact(run.id);
	if (blob.type !== "image/png")
		throw new Error(`Unexpected image MIME: ${blob.type}`);
	const file = resolve(directory, `${screen.id}.png`);
	await writeFile(file, new Uint8Array(await blob.arrayBuffer()));
	await writeFile(
		resolve(directory, `${screen.id}.prompt.txt`),
		common + "\nScreen: " + screen.description + "\n",
	);
	entry.status = "saved";
	entry.file = file;
	entry.model = run.actualModel ?? run.model;
	await persist();
	console.log(JSON.stringify({ screen: screen.id, status: "saved", file }));
}
