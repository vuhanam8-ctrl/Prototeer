import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

const role = v.union(v.literal("owner"), v.literal("editor"), v.literal("viewer"));
const simulationStatus = v.union(v.literal("paused"), v.literal("running"));

export default defineSchema({
  workspaces: defineTable({
    publicId: v.string(),
    name: v.string(),
    createdAt: v.number(),
    publishedAt: v.optional(v.number()),
  }).index("by_public_id", ["publicId"]),

  workspaceCapabilities: defineTable({
    workspaceId: v.id("workspaces"),
    tokenDigest: v.string(),
    role,
    label: v.string(),
    createdAt: v.number(),
    revokedAt: v.optional(v.number()),
  })
    .index("by_token_digest", ["tokenDigest"])
    .index("by_workspace", ["workspaceId"]),

  projects: defineTable({
    publicId: v.string(),
    workspaceId: v.optional(v.id("workspaces")),
    name: v.string(),
    preview: v.optional(v.string()),
    formatVersion: v.number(),
    currentRevision: v.number(),
    snapshotRevision: v.number(),
    currentSnapshotId: v.optional(v.id("projectRevisions")),
    createdAt: v.number(),
    updatedAt: v.number(),
    deletedAt: v.optional(v.number()),
    simulationStatus,
    simulationGeneration: v.number(),
    simulationController: v.optional(v.string()),
    simulationLeaseUntil: v.optional(v.number()),
    simulationTick: v.number(),
    simulationSnapshotId: v.optional(v.id("projectRevisions")),
    simulationSourceRevision: v.optional(v.number()),
  })
    .index("by_public_id", ["publicId"])
    .index("by_workspace", ["workspaceId", "deletedAt"])
    .index("by_updated_at", ["updatedAt"])
    .index("by_simulation_lease", ["simulationStatus", "simulationLeaseUntil"]),

  projectCapabilities: defineTable({
    projectId: v.id("projects"),
    tokenDigest: v.string(),
    role,
    label: v.string(),
    createdAt: v.number(),
    revokedAt: v.optional(v.number()),
  })
    .index("by_token_digest", ["tokenDigest"])
    .index("by_project_token", ["projectId", "tokenDigest"])
    .index("by_project", ["projectId"]),

  projectRevisions: defineTable({
    projectId: v.id("projects"),
    revision: v.number(),
    kind: v.union(v.literal("project"), v.literal("simulation")),
    reason: v.string(),
    createdAt: v.number(),
    createdBy: v.string(),
    byteLength: v.number(),
    chunkCount: v.number(),
  })
    .index("by_project_revision", ["projectId", "revision"])
    .index("by_project_kind", ["projectId", "kind"]),

  revisionChunks: defineTable({
    revisionId: v.id("projectRevisions"),
    index: v.number(),
    json: v.string(),
  }).index("by_revision_index", ["revisionId", "index"]),

  projectOperations: defineTable({
    projectId: v.id("projects"),
    sequence: v.number(),
    opId: v.string(),
    sessionId: v.string(),
    kind: v.string(),
    resourceKey: v.string(),
    expectedVersion: v.number(),
    resultingVersion: v.number(),
    payload: v.any(),
    createdAt: v.number(),
  })
    .index("by_project_sequence", ["projectId", "sequence"])
    .index("by_project_op", ["projectId", "opId"]),

  resourceVersions: defineTable({
    projectId: v.id("projects"),
    resourceKey: v.string(),
    version: v.number(),
    deleted: v.boolean(),
    updatedAt: v.number(),
    updatedBy: v.string(),
  }).index("by_project_resource", ["projectId", "resourceKey"]),

  presence: defineTable({
    projectId: v.id("projects"),
    sessionId: v.string(),
    role,
    displayName: v.string(),
    color: v.string(),
    view: v.string(),
    editingKind: v.optional(v.string()),
    editingId: v.optional(v.string()),
    pointerX: v.optional(v.number()),
    pointerY: v.optional(v.number()),
    lastSeen: v.number(),
  })
    .index("by_project_session", ["projectId", "sessionId"])
    .index("by_project_seen", ["projectId", "lastSeen"])
    .index("by_last_seen", ["lastSeen"]),

  assets: defineTable({
    projectId: v.id("projects"),
    publicId: v.string(),
    storageId: v.id("_storage"),
    contentType: v.string(),
    byteLength: v.number(),
    sha256: v.optional(v.string()),
    originalName: v.optional(v.string()),
    createdBy: v.string(),
    createdAt: v.number(),
  })
    .index("by_project_public_id", ["projectId", "publicId"])
    .index("by_project_created", ["projectId", "createdAt"])
    .index("by_storage_id", ["storageId"]),

  assetUploadGrants: defineTable({
    projectId: v.id("projects"),
    sessionId: v.string(),
    createdAt: v.number(),
    expiresAt: v.number(),
    usedAt: v.optional(v.number()),
  })
    .index("by_project_created", ["projectId", "createdAt"])
    .index("by_expiry", ["expiresAt"]),

  analyticsSessions: defineTable({
    sessionId: v.string(),
    participantId: v.string(),
    consentVersion: v.number(),
    uiVersion: v.string(),
    viewportWidth: v.number(),
    viewportHeight: v.number(),
    dpr: v.number(),
    startedAt: v.number(),
    endedAt: v.optional(v.number()),
    lastSeenAt: v.number(),
    lastSequence: v.number(),
    eventCount: v.number(),
    heatmapCount: v.number(),
  })
    .index("by_session", ["sessionId"])
    .index("by_participant_started", ["participantId", "startedAt"])
    .index("by_started", ["startedAt"])
    .index("by_last_seen", ["lastSeenAt"]),

  analyticsEvents: defineTable({
    sessionId: v.string(),
    schemaVersion: v.number(),
    eventId: v.string(),
    sequence: v.number(),
    occurredAt: v.number(),
    uiVersion: v.string(),
    kind: v.string(),
    surface: v.union(v.literal("ui"), v.literal("board")),
    panel: v.string(),
    controlId: v.optional(v.string()),
    flow: v.optional(v.string()),
    result: v.optional(v.string()),
    durationMs: v.optional(v.number()),
    viewportWidth: v.number(),
    viewportHeight: v.number(),
    dpr: v.number(),
    context: v.optional(v.any()),
  })
    .index("by_event", ["eventId"])
    .index("by_time", ["occurredAt"]),

  analyticsHeatmapBins: defineTable({
    sessionId: v.string(),
    uiVersion: v.string(),
    surface: v.union(v.literal("ui"), v.literal("board")),
    panel: v.string(),
    kind: v.union(v.literal("click"), v.literal("pointer"), v.literal("scroll")),
    xBin: v.number(),
    yBin: v.number(),
    viewportBucket: v.string(),
    pointerType: v.optional(v.string()),
    binKey: v.string(),
    count: v.number(),
    occurredAt: v.number(),
  })
    .index("by_session_bin", ["sessionId", "binKey"])
    .index("by_time", ["occurredAt"]),

  analyticsBatches: defineTable({
    sessionId: v.string(),
    batchId: v.string(),
    createdAt: v.number(),
  })
    .index("by_session_batch", ["sessionId", "batchId"])
    .index("by_time", ["createdAt"]),
});
