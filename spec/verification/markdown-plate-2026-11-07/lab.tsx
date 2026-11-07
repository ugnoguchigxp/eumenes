/** Disposable test surface, not the proposed product UI. */
import React from "react";
import { createRoot } from "react-dom/client";
import { Plate, PlateContent } from "platejs/react";
import { editorFor } from "./plate";

type Snapshot = { revision: number; text: string; title?: string };
const editor = editorFor();
let saved: Snapshot = { revision: 0, text: "" };
let currentText = "", dirty = false, composing = false, rendered = "";
let editEpoch = 0, saving = false, draftConflict = false;
let draftBaseRevision = 0;
let status = "ready";
let failSave = false;
const events: unknown[] = [];
const key = "eumenes-plate-lab-draft";
const draft = () => localStorage.setItem(key, JSON.stringify({ baseRevision: draftBaseRevision, text: currentText }));

function load(snapshot: Snapshot, recover = false) {
	saved = snapshot;
	const kept = recover ? JSON.parse(localStorage.getItem(key) ?? "null") : null;
	draftBaseRevision = kept?.baseRevision ?? snapshot.revision;
	dirty = !!kept;
	draftConflict = !!kept && kept.baseRevision !== snapshot.revision;
	composing = false;
	currentText = kept?.text ?? snapshot.text;
	editor.tf.setValue(editor.api.markdown.deserialize(currentText));
	rendered = editor.api.markdown.serialize();
	status = draftConflict ? "draft-conflict" : kept ? "recovered" : "loaded";
}
async function save() {
	if (composing) return "composing";
	if (draftConflict) return "conflict";
	if (saving) return "saving";
	if (!dirty) return "unchanged";
	const epoch = editEpoch;
	saving = true;
	try {
		if (failSave) throw new Error("offline");
		const result = await (window as any).labStore("save", { baseRevision: saved.revision, text: currentText });
		if (result.status === "conflict") {
			draftConflict = true;
			status = "conflict";
			draft();
			return "conflict";
		}
		saved = result.snapshot;
		draftBaseRevision = saved.revision;
		if (editEpoch !== epoch) {
			draft();
			status = "newer-draft";
			return "saved-with-newer-draft";
		}
		dirty = false;
		localStorage.removeItem(key);
		status = "saved";
		return "saved";
	} catch {
		status = "save-failed";
		draft();
		return "save-failed";
	} finally { saving = false; }
}
function remote(snapshot: Snapshot) {
	if (dirty || composing) { status = "remote-pending"; return "blocked"; }
	if (snapshot.revision <= saved.revision) return "stale";
	load(snapshot);
	return "applied";
}
function App() {
	return <main><p>Plate adoption laboratory — product UI is not implemented here.</p><Plate editor={editor} onValueChange={() => {
		const text = editor.api.markdown.serialize();
		if (text === rendered) return;
		rendered = text;
		editEpoch++;
		currentText = text;
		dirty = true;
		if (!composing) draft();
	}}><PlateContent data-testid="editor" aria-label="検証文書" spellCheck={false} onCompositionStart={() => { composing = true; }} onCompositionEnd={() => { composing = false; if (dirty) draft(); }} /></Plate><button onClick={save}>保存</button></main>;
}
createRoot(document.getElementById("root")!).render(<App />);
for (const event of ["compositionstart", "compositionupdate", "compositionend", "beforeinput", "input"])
	document.addEventListener(event, (e: Event) => events.push({ type: e.type, data: (e as InputEvent).data, inputType: (e as InputEvent).inputType, isComposing: (e as InputEvent).isComposing }));
(window as any).lab = {
	load, save, remote,
	state: () => ({ saved, text: dirty ? currentText : saved.text, rendered: editor.api.markdown.serialize(), dirty, composing, saving, draftConflict, status, events }),
	clearDraft: () => localStorage.removeItem(key),
	setFailSave: (value: boolean) => { failSave = value; },
	undo: () => editor.tf.undo(),
	format: () => { editor.tf.select(editor.api.range([])!); editor.tf.addMarks({ bold: true, underline: true, color: "#ff0000", fontSize: "24px" }); editor.tf.setNodes({ align: "center" }, { match: n => (n as any).type === "p" }); },
};
