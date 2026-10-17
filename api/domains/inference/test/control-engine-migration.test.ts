import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import { migrations } from "..";
import { migrations as settingsMigrations } from "../../settings";

test("a control engine saved under the model-derived name becomes the model-neutral engine", async () => {
  const dir = mkdtempSync(join(tmpdir(), "eumenes-engine-migration-"));
  const path = join(dir, "test.db");
  const before = [
    ...settingsMigrations,
    ...migrations.slice(
      0,
      migrations.findIndex(
        (m) => m.id === "inference/0011-control-engine-codex",
      ),
    ),
  ];
  let store = openStore(path, before);
  try {
    await store.write((db) => {
      for (const [id, engine] of [
        ["a", "codex_luna"],
        ["b", "larm"],
      ] as const)
        db.query(
          "INSERT INTO inference_requests(id,subject,purpose,snapshot,deadline,mode,control_engine) VALUES(?,?,'llm','{}',123,'control',?)",
        ).run(id, `subject-${id}`, engine);
    });
    await store.close();
    store = openStore(path, [...settingsMigrations, ...migrations]);
    expect(
      store.read((db) =>
        db
          .query("SELECT id,control_engine FROM inference_requests ORDER BY id")
          .all(),
      ),
    ).toEqual([
      { id: "a", control_engine: "codex" },
      { id: "b", control_engine: "larm" },
    ]);
    // The replaced column keeps its constraint and its default.
    await store.write((db) => {
      db.query(
        "INSERT INTO inference_requests(id,subject,purpose,snapshot,deadline) VALUES('c','subject-c','llm','{}',123)",
      ).run();
      expect(() =>
        db
          .query(
            "UPDATE inference_requests SET control_engine='other' WHERE id='c'",
          )
          .run(),
      ).toThrow();
    });
    expect(
      store.read((db) =>
        db
          .query("SELECT control_engine FROM inference_requests WHERE id='c'")
          .get(),
      ),
    ).toEqual({ control_engine: "larm" });
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
