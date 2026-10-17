import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { openStore, type SqliteStore } from "../../../infrastructure/sqlite";
import { migrations } from "../repository";
import { migrations as settingsMigrations } from "../../settings";
import { createUsageReader } from "../service/usage";
import { usagePageQuerySchema } from "../contracts";
import { registerInference } from "../controller";
import type { InferenceService } from "../service";

let store: SqliteStore, dir: string;
afterEach(async () => {
  if (store) await store.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});
test("usage API sorts and searches the entire retained dataset before pagination, with stable ties and bounded input", async () => {
  dir = mkdtempSync(join(tmpdir(), "usage-pages-"));
  store = openStore(join(dir, "db"), [...settingsMigrations, ...migrations]);
  await store.write((db) => {
    for (let i = 0; i < 125; i++) {
      const id = String(i).padStart(3, "0");
      db.query(
        "INSERT INTO inference_requests(id,subject,purpose,snapshot,deadline) VALUES(?,?,?,?,?)",
      ).run(id, "subject-" + id, "llm", "{}", 1);
      db.query(
        "INSERT INTO inference_attempts(id,request_id,source,model,status,started,ended,accepted) VALUES(?,?,?,?,?,?,?,?)",
      ).run(
        id,
        id,
        "larm",
        "global-" + id,
        i % 2 ? "failed" : "succeeded",
        i,
        i + 1,
        i % 2 ? 0 : 1,
      );
    }
    db.query(
      "INSERT INTO inference_requests(id,subject,purpose,snapshot,deadline) VALUES('probe','probe:test','llm','{}',1)",
    ).run();
    db.query(
      "INSERT INTO inference_attempts(id,request_id,source,model,status,started) VALUES('probe','probe','larm','global-000','succeeded',999)",
    ).run();
    db.query("UPDATE inference_attempts SET reason=? WHERE id='001'").run(
      "literal_%'suffix",
    );
  });
  const reader = createUsageReader(store);
  expect(reader.usage()).toHaveLength(100);
  expect(reader.usage().some((row) => row.model === "global-000")).toBe(false);
  const query = (v: object = {}) => usagePageQuerySchema.parse(v);
  expect(reader.usagePage(query({ q: "global-000" }))).toMatchObject({
    total: 1,
    pageIndex: 0,
    items: [{ id: "000" }],
  });
  expect(reader.usagePage(query({ q: "_%'" }))).toMatchObject({
    total: 1,
    items: [{ id: "001" }],
  });
  expect(reader.usagePage(query({ q: "会話" })).total).toBe(125);
  expect(reader.usagePage(query({ q: "採用済み" })).total).toBe(63);
  const asc = reader.usagePage(query({ sort: "model", desc: false }));
  expect(asc.total).toBe(125);
  expect(asc.items.map((r) => r.id)).toEqual(
    Array.from({ length: 10 }, (_, i) => String(i).padStart(3, "0")),
  );
  const next = reader.usagePage(
    query({ sort: "model", desc: false, pageIndex: 1 }),
  );
  expect(next.items[0]?.id).toBe("010");
  const last = reader.usagePage(query({ pageIndex: 999 }));
  expect(last.pageIndex).toBe(12);
  expect(last.items).toHaveLength(5);
  for (const sort of ["purpose", "source", "status", "started"] as const)
    expect(reader.usagePage(query({ sort })).items).toHaveLength(10);
  const app = new Hono();
  registerInference(app, reader as unknown as InferenceService);
  for (const raw of [
    "sort=model;drop",
    "pageSize=500",
    "pageIndex=-1",
    "desc=evil",
    "q=" + "x".repeat(201),
    "unknown=1",
  ])
    expect((await app.request("/api/inference/usage/page?" + raw)).status).toBe(
      400,
    );
  expect(
    (
      await app.request(
        "/api/inference/usage/page?sort=model&desc=false&pageIndex=1",
      )
    ).status,
  ).toBe(200);
  await store.write((db) => {
    db.query(
      "INSERT INTO inference_attempts(id,request_id,source,model,status,started) VALUES('pending','001','larm',NULL,'pending',999)",
    ).run();
  });
  expect(reader.usage()[0]?.model).toBeNull();
  expect(reader.usagePage(query({ q: "不明" }))).toMatchObject({
    total: 1,
    items: [{ id: "pending", model: "不明" }],
  });
  expect(reader.usagePage(query()).total).toBe(126);
});
