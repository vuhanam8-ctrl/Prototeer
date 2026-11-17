import assert from "node:assert/strict";
import fs from "node:fs";

const read = file => fs.readFileSync(new URL(file, import.meta.url), "utf8");
const schema = read("./convex/schema.ts");
const access = read("./convex/lib/access.ts");
const projects = read("./convex/projects.ts");
const collaboration = read("./convex/collaboration.ts");
const simulation = read("./convex/simulation.ts");
const assets = read("./convex/assets.ts");
const analytics = read("./convex/analytics.ts");
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

test("capabilities store digests and never raw access keys", () => {
  const capabilityTable = schema.match(/projectCapabilities:[\s\S]*?\n\s*presence:/)?.[0] ?? "";
  assert.match(capabilityTable, /tokenDigest: v\.string\(\)/);
  assert.doesNotMatch(capabilityTable, /\n\s*(?:token|accessKey):/);
  assert.match(access, /crypto\.subtle\.digest\("SHA-256"/);
  assert.match(access, /token\.length < 43/);
});

test("every collaboration entry point authorizes the capability", () => {
  for (const name of ["submitOperation", "tail", "updatePresence", "listPresence"]) {
    const section = collaboration.split(`export const ${name}`)[1]?.split("export const ")[0] ?? "";
    assert.match(section, /requireAccess\(/, name);
  }
  assert.match(collaboration.split("export const submitOperation")[1], /requireEditor\(capability\.role\)/);
});

test("shared simulation uses controller identity, generation fencing and leases", () => {
  assert.match(simulation, /simulationController !== args\.sessionId/);
  assert.match(simulation, /simulationGeneration !== args\.generation/);
  assert.match(simulation, /simulationLeaseUntil/);
  assert.match(simulation, /simulationSourceRevision/);
});

test("snapshots and operation replay stay bounded", () => {
  const openLimit = Number(projects.match(/OPEN_OPERATION_LIMIT = (\d+)/)?.[1]);
  assert.ok(openLimit >= 1 && openLimit <= 4);
  assert.match(collaboration, /OPERATION_PAGE_SIZE = 10/);
  assert.match(projects, /pruneCheckpointedOperations/);
  assert.match(schema, /revisionChunks:/);
});

test("artwork uses authorized Convex storage grants", () => {
  for (const name of ["createUploadUrl", "finalizeUpload", "list", "get", "remove"]) {
    const section = assets.split(`export const ${name}`)[1]?.split("export const ")[0] ?? "";
    assert.match(section, /requireAccess\(/, name);
  }
  assert.match(assets, /ctx\.storage\.generateUploadUrl\(\)/);
  assert.match(assets, /ctx\.storage\.getUrl/);
  assert.match(assets, /MAX_PROJECT_ASSET_BYTES/);
});

test("analytics is separate, bounded and owner-only to export or delete", () => {
  assert.match(schema, /analyticsSessions:/);
  assert.match(schema, /analyticsEvents:/);
  assert.match(schema, /analyticsHeatmapBins:/);
  assert.doesNotMatch(schema.match(/analyticsEvents:[\s\S]*?analyticsHeatmapBins:/)?.[0] ?? "", /projectJson|artwork|description|accessKey/);
  for (const name of ["exportSessions", "exportEvents", "exportHeatmap", "clear"]) {
    const section = analytics.split(`export const ${name}`)[1]?.split("export const ")[0] ?? "";
    assert.match(section, /requireOwner\(capability\.role\)/, name);
  }
  assert.match(analytics, /MAX_EVENTS_PER_BATCH/);
  assert.match(analytics, /MAX_HEATMAP_SAMPLES_PER_SESSION/);
});

console.log(`${passed} backend contract tests passed.`);
