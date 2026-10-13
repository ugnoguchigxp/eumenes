import { Button } from "../Button";
import { Input } from "../Input";
export type DrawingWorkspaceProps = {
 title?: string; status: string; error?: string; busy?: boolean;
 references: Array<{ id: string; title: string; revision: number }>;
 url?: string; onNew: () => void; onOpen: (id: string) => void; onRefresh: () => void;
};
/** API/authentication and lease ownership belong to the host. */
export function DrawingWorkspace(p: DrawingWorkspaceProps) {
 return <section aria-label={p.title ?? "図を描く・編集する"} className="ds-drawing-workspace" style={{ padding: 16, display: "grid", gap: 12 }}>
  <h2>{p.title ?? "図を描く・編集する"}</h2>
  <p role="status">{p.status}</p>{p.error && <p role="alert">{p.error}</p>}
  <Button disabled={p.busy} onClick={p.onNew}>新しい図</Button>
  <Button disabled={p.busy} onClick={p.onRefresh}>一覧を再表示</Button>
  {p.url && <p><a href={p.url} target="_blank" rel="noreferrer">Excalidrawを開く</a></p>}
  <ul>{p.references.map(r => <li key={r.id}><Button disabled={p.busy} onClick={() => p.onOpen(r.id)}>{r.title}（版 {r.revision}）</Button></li>)}</ul>
  {!p.references.length && <p>保存済みの図はありません。</p>}
 </section>;
}
export type DrawingEditorFrameProps = {
 title: string; status: string; error?: string; busy: boolean; hasDraft: boolean;
 onTitle: (title: string) => void; onSave: () => void; onReconnect: () => void;
 onRestore: () => void; onDownload: () => void; onClose: () => void;
 children?: import("react").ReactNode;
};
export function DrawingEditorFrame(p: DrawingEditorFrameProps) {
 return <main style={{ height: "100dvh", display: "flex", flexDirection: "column" }} aria-label="Excalidraw編集画面">
  <header style={{ display: "flex", gap: 8, alignItems: "center", padding: 8, flexWrap: "wrap" }}>
   <Input style={{ width: 240 }} maxLength={200} aria-label="図の名前" value={p.title} onChange={e => p.onTitle(e.target.value)} disabled={p.busy}/>
   <Button onClick={p.onSave} disabled={p.busy}>保存</Button>
   <Button onClick={p.onReconnect} disabled={p.busy}>再接続</Button>
   {p.hasDraft && <Button onClick={p.onRestore} disabled={p.busy}>下書きを復元</Button>}
   <Button onClick={p.onDownload}>編集中の図をダウンロード</Button>
   <Button onClick={p.onClose}>閉じる</Button><output role="status">{p.status}</output>
  </header>{p.error && <p role="alert">{p.error}</p>}
  <section style={{ flex: 1, minHeight: 0 }}>{p.children}</section>
 </main>;
}
