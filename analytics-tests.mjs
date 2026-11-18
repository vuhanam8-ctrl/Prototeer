import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const context = vm.createContext({ console });
vm.runInContext(fs.readFileSync(new URL("./public/analytics.js", import.meta.url), "utf8"), context);
const analytics = context.PrototeerAnalytics;
let passed = 0;

async function test(name, run) {
  try {
    await run();
    passed++;
  } catch (error) {
    error.message = `${name}: ${error.message}`;
    throw error;
  }
}

function options(overrides = {}) {
  return {
    sessionId: "session-1",
    participantId: "participant-1",
    uiVersion: "dev-1",
    viewport: () => ({ width: 1440, height: 900, dpr: 1 }),
    flushIntervalMs: 0,
    ...overrides,
  };
}

await test("declining analytics records and sends nothing", async () => {
  const sent = [];
  const client = analytics.createAnalytics(options({ consent: false, transport: { batch: (items) => sent.push(...items) } }));
  assert.equal(client.record("panel_opened", { panel: "board" }), false);
  assert.equal(client.sampleHeatmap("click", { panel: "board", x: 1, y: 1, width: 10, height: 10 }), false);
  await client.flush();
  assert.equal(sent.length, 0);
  assert.deepEqual({ ...client.pendingCounts() }, { events: 0, bins: 0 });
});

await test("declined collection schedules no background flush work", async () => {
  let scheduled = 0;
  let cleared = 0;
  const client = analytics.createAnalytics(options({
    consent: false,
    flushIntervalMs: 5000,
    setIntervalFn: () => { scheduled++; return 7; },
    clearIntervalFn: () => { cleared++; },
  }));
  assert.equal(scheduled, 0);
  client.setConsent(true);
  assert.equal(scheduled, 1);
  client.setConsent(false);
  assert.equal(cleared, 1);
  await client.destroy();
});

await test("consented semantic events use only the safe envelope", async () => {
  const sent = [];
  const client = analytics.createAnalytics(options({
    consent: true,
    allowedControls: ["run-button"],
    transport: { batch: (items) => sent.push(...items) },
  }));
  assert.equal(client.record("simulation_run", {
    surface: "ui",
    panel: "header",
    controlId: "run-button",
    context: { source: "toolbar", permission: "editor" },
  }), true);
  await client.flush();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].kind, "simulation_run");
  assert.deepEqual({ ...sent[0].context }, { source: "toolbar", permission: "editor" });
  assert.equal("description" in sent[0], false);
  assert.equal("projectId" in sent[0], false);
});

await test("dynamic controls can be allowlisted without recording their values or text", async () => {
  const sent = [];
  const client = analytics.createAnalytics(options({ consent: true, transport: { batch: (items) => sent.push(...items) } }));
  assert.equal(client.allowControl("dynamicModalControl"), true);
  assert.equal(client.record("control_clicked", { panel: "dialog", controlId: "dynamicModalControl" }), true);
  assert.equal(client.allowControl("contains spaces"), false);
  await client.flush();
  assert.equal(sent.length, 1);
  assert.deepEqual(Object.keys(sent[0]).includes("value"), false);
});

await test("arbitrary text, controls, context keys and artwork are rejected", async () => {
  const client = analytics.createAnalytics(options({ consent: true, allowedControls: ["safe-control"] }));
  assert.equal(client.record("control_changed", { panel: "dialog", controlId: "project-secret-name" }), false);
  assert.equal(client.record("control_changed", { panel: "dialog", controlId: "safe-control", context: { description: "private notes" } }), false);
  assert.equal(client.record("control_changed", { panel: "dialog", controlId: "safe-control", context: { source: "data:image/png;base64,secret" } }), false);
  assert.deepEqual({ ...client.pendingCounts() }, { events: 0, bins: 0 });
});

await test("heatmaps aggregate normalized region bins and keep board separate from UI", async () => {
  let clock = 1000;
  const batches = [];
  const client = analytics.createAnalytics(options({
    consent: true,
    now: () => clock,
    transport: { batchHeatmap: (items) => batches.push(...items) },
  }));
  assert.equal(client.sampleHeatmap("click", { surface: "board", panel: "board", x: 50, y: 25, width: 100, height: 100, pointerType: "mouse" }), true);
  assert.equal(client.sampleHeatmap("click", { surface: "ui", panel: "inspector", x: 50, y: 25, width: 100, height: 100, pointerType: "mouse" }), true);
  assert.equal(client.sampleHeatmap("pointer", { surface: "board", panel: "board", x: 10, y: 10, width: 100, height: 100 }), true);
  clock += 20;
  assert.equal(client.sampleHeatmap("pointer", { surface: "board", panel: "board", x: 11, y: 11, width: 100, height: 100 }), false, "pointer samples are throttled");
  await client.flush();
  assert.equal(batches.length, 3);
  assert.equal(batches[0].xBin, 16);
  assert.equal(batches[0].yBin, 4);
  assert.deepEqual(new Set(batches.map((item) => item.surface)), new Set(["board", "ui"]));
});

await test("editing flows record abandonment and completion durations", async () => {
  let clock = 100;
  const sent = [];
  const client = analytics.createAnalytics(options({
    consent: true,
    now: () => clock,
    transport: { batch: (items) => sent.push(...items) },
  }));
  assert.equal(client.beginFlow("zone"), true);
  clock += 50;
  assert.equal(client.beginFlow("stat"), true);
  clock += 25;
  assert.equal(client.completeFlow(), true);
  await client.flush();
  assert.deepEqual(sent.map((item) => item.kind), ["editor_opened", "editor_abandoned", "editor_opened", "editor_completed"]);
  assert.equal(sent[1].durationMs, 50);
  assert.equal(sent[3].durationMs, 25);
});

await test("transport failures never escape and retain bounded unsent data", async () => {
  const client = analytics.createAnalytics(options({
    consent: true,
    transport: {
      batch: () => { throw new Error("offline"); },
      batchHeatmap: async () => { throw new Error("offline"); },
    },
  }));
  client.record("panel_opened", { panel: "zones" });
  client.sampleHeatmap("click", { panel: "zones", x: 2, y: 2, width: 10, height: 10 });
  await assert.doesNotReject(client.flush());
  assert.deepEqual({ ...client.pendingCounts() }, { events: 1, bins: 1 });
});

await test("a failed session start is retried before queued events are sent", async () => {
  let attempts = 0;
  const sent = [];
  const client = analytics.createAnalytics(options({
    consent: true,
    transport: {
      startSession: () => {
        attempts++;
        if (attempts === 1) throw new Error("offline");
      },
      batch: (items) => sent.push(...items),
    },
  }));
  client.record("panel_opened", { panel: "zones" });
  assert.equal(await client.flush(), false);
  assert.equal(sent.length, 0);
  assert.equal(client.pendingCounts().events, 1);
  assert.equal(await client.flush(), true);
  assert.equal(sent.length, 1);
  assert.equal(attempts, 2);
});

await test("customer collector exposes no analytics read or export helpers", () => {
  assert.equal("analyticsExport" in analytics, false);
  assert.equal("analyticsCsv" in analytics, false);
});

console.log(`${passed} analytics tests passed.`);
