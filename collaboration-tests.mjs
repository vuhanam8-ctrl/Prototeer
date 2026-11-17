import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { bootEditor } from "./editor-smoke.mjs";

const context = vm.createContext({ console });
vm.runInContext(fs.readFileSync(new URL("./public/project-operations.js", import.meta.url), "utf8"), context);
const ops = context.PrototeerProjectOps;
const adapterContext = vm.createContext({ console, TextEncoder, structuredClone, URL, URLSearchParams });
adapterContext.globalThis = adapterContext;
vm.runInContext(fs.readFileSync(new URL("./public/collaboration.js", import.meta.url), "utf8"), adapterContext);
const adapter = adapterContext.PrototeerCollaboration;
let passed = 0;

function test(name, run) {
  try {
    run();
    passed++;
  } catch (error) {
    error.message = `${name}: ${error.message}`;
    throw error;
  }
}

function project(overrides = {}) {
  return {
    id: "project-1",
    name: "Test project",
    year: 1,
    tools: [],
    stats: [],
    tagDefs: [],
    zones: [],
    directors: [],
    entities: [],
    factions: [],
    history: [],
    historySettings: { enabled: false },
    tutorial: {},
    events: [],
    messageRoutes: [],
    messageDebug: [],
    signals: [],
    ...overrides,
  };
}

test("world diffs are deterministic and reconstruct the edited project", () => {
  const before = project({
    tools: [{ id: "tool-a", name: "A", color: "#000000" }],
    zones: [{ id: "zone-a", name: "Area", enabled: true, cells: [1, 3] }],
  });
  const after = project({
    name: "Renamed",
    tools: [
      { id: "tool-a", name: "A", color: "#ffffff" },
      { id: "tool-b", name: "B", color: "#808080" },
    ],
    zones: [{ id: "zone-a", name: "Area", enabled: true, cells: [2, 3] }],
    year: 2,
  });
  const first = ops.diffWorld(before, after, { "tools:tool-a": 4, "root:name": 2 });
  const second = ops.diffWorld(structuredClone(before), structuredClone(after), { "tools:tool-a": 4, "root:name": 2 });
  assert.deepEqual(JSON.parse(JSON.stringify(first)), JSON.parse(JSON.stringify(second)));
  assert.equal(first.find((item) => item.resourceKey === "tools:tool-a").expectedVersion, 4);
  assert.equal(first.find((item) => item.kind === "renameProject").expectedVersion, 2);
  const rebuilt = ops.applyOperations(before, first);
  assert.equal(ops.stableStringify(rebuilt), ops.stableStringify(after));
  assert.equal(before.name, "Test project", "diff/apply must not mutate the caller's project");
});

test("independent zone cell edits merge instead of replacing the zone", () => {
  const base = project({ zones: [{ id: "zone-a", name: "Area", cells: [] }] });
  const first = ops.diffWorld(base, project({ zones: [{ id: "zone-a", name: "Area", cells: [4] }] }));
  const second = ops.diffWorld(base, project({ zones: [{ id: "zone-a", name: "Area", cells: [9] }] }));
  let merged = ops.applyOperations(base, first);
  merged = ops.applyOperations(merged, second);
  assert.deepEqual(Array.from(merged.zones[0].cells), [4, 9]);
});

test("zone metadata updates preserve cells received from another editor", () => {
  const base = project({ zones: [{ id: "zone-a", name: "Area", color: "#000000", cells: [5] }] });
  const changed = project({ zones: [{ id: "zone-a", name: "Renamed area", color: "#000000", cells: [5] }] });
  const metadata = ops.diffWorld(base, changed).find((item) => item.kind === "setRecord");
  assert.equal(Object.hasOwn(metadata.payload.value, "cells"), false);
  const withRemoteCell = project({ zones: [{ id: "zone-a", name: "Area", color: "#000000", cells: [5, 8] }] });
  const applied = ops.applyOperation(withRemoteCell, metadata);
  assert.equal(applied.zones[0].name, "Renamed area");
  assert.deepEqual(Array.from(applied.zones[0].cells), [5, 8]);
});

test("large zone strokes are split into backend-sized operations", () => {
  const cells = Array.from({ length: 1201 }, (_, index) => index);
  const before = project({ zones: [{ id: "zone-a", name: "Area", cells: [] }] });
  const after = project({ zones: [{ id: "zone-a", name: "Area", cells }] });
  const changes = ops.diffWorld(before, after).filter((item) => item.kind === "paintZoneCells");
  assert.equal(changes.length, 2);
  assert.equal(changes.flatMap((item) => item.payload.add).length, 1201);
  assert.ok(changes.every((item) => item.payload.add.length + item.payload.remove.length <= ops.MAX_ZONE_CHANGES));
});

test("record deletion only removes the addressed stable ID", () => {
  const before = project({ stats: [{ id: "a", name: "A" }, { id: "b", name: "B" }] });
  const after = project({ stats: [{ id: "b", name: "B" }] });
  const changes = ops.diffWorld(before, after);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].kind, "deleteRecord");
  assert.deepEqual(Array.from(ops.applyOperations(before, changes).stats, (item) => item.id), ["b"]);
});

test("root deletion is explicit and does not serialize undefined", () => {
  const before = project({ tutorial: { active: true } });
  const after = project();
  delete after.tutorial;
  const change = ops.diffWorld(before, after).find((item) => item.resourceKey === "root:tutorial");
  assert.equal(change.payload.delete, true);
  const applied = ops.applyOperation(before, JSON.parse(JSON.stringify(change)));
  assert.equal(Object.hasOwn(applied, "tutorial"), false);
});

test("version advancement accepts authoritative server versions", () => {
  const versions = ops.advanceVersions({ "root:name": 1 }, [
    { resourceKey: "root:name", expectedVersion: 1, resultingVersion: 7 },
    { resourceKey: "stats:a", expectedVersion: 0 },
  ]);
  assert.equal(versions.get("root:name"), 7);
  assert.equal(versions.get("stats:a"), 1);
});

test("unsupported operations cannot mutate a project", () => {
  assert.throws(() => ops.applyOperation(project(), { kind: "replaceProject", payload: {} }), /Unsupported/);
});

test("UTF-8 snapshot chunks reassemble exactly without splitting artwork or Unicode", () => {
  const original = { name: "Shared 🙂 project", text: "🙂".repeat(180000) };
  const snapshot = adapter.splitUtf8(original);
  assert.ok(snapshot.chunks.length > 1);
  assert.deepEqual(JSON.parse(snapshot.chunks.join("")), original);
  assert.equal(snapshot.chunks.reduce((total, chunk) => total + new TextEncoder().encode(chunk).length, 0), snapshot.byteLength);
  assert.ok(snapshot.chunks.every((chunk) => new TextEncoder().encode(chunk).length <= 650000));
});

test("shared capability secrets stay in the URL fragment", () => {
  adapterContext.location = { href: "https://example.test/Prototeer/dev/" };
  const shared = new URL(adapter.accessUrl("project_1234567890", "a".repeat(64), "https://demo.convex.cloud"));
  assert.equal(shared.search, "");
  assert.match(shared.hash, /project=/);
  assert.match(shared.hash, /access=/);
  assert.match(shared.hash, /backend=/);
});

test("remote edits preserve the local camera and open editor", () => {
  let hooks;
  const fakeCollaboration = {
    create(options) {
      hooks = options.hooks;
      return {
        active: () => true,
        canEdit: () => true,
        editableWorld: () => null,
        projectChanged() {},
        setPresence() {},
        joinFromLocation: async () => null,
        role: () => "editor",
      };
    },
  };
  const { editor, get } = bootEditor({ globals: { PrototeerCollaboration: fakeCollaboration, PrototeerProjectOps: ops } });
  editor.setMode("pan");
  get("board").onpointerdown({ clientX: 100, clientY: 100, pointerId: 1 });
  get("board").onpointermove({ clientX: 160, clientY: 130, pointerId: 1 });
  get("board").onpointerup();
  const camera = { ...editor.transform() };
  get("help").click();
  assert.equal(get("dialog").open, true);
  const before = editor.world().tools[0];
  hooks.onRemoteOperations([{
    kind: "setRecord",
    resourceKey: `tools:${before.id}`,
    payload: { collection: "tools", id: before.id, value: { ...structuredClone(before), name: "Remote rename" } },
  }]);
  assert.equal(editor.world().tools[0].name, "Remote rename");
  assert.equal(get("dialog").open, true);
  assert.equal(JSON.stringify(editor.transform()), JSON.stringify(camera));
});

console.log(`${passed} collaboration operation tests passed.`);
