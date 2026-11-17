import { mutation, query, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { v, ConvexError } from "convex/values";
import { requireAccess, requireEditor, safeOpId, safeSessionId } from "./lib/access";

const OPERATION_PAGE_SIZE = 10;
const MAX_PROJECT_PRESENCE = 100;
const MAX_RESOURCE_VERSIONS = 4_000;

const operationKinds = new Set(["setRecord", "deleteRecord", "paintZoneCells", "setRoot", "renameProject"]);
const recordCollections = new Set(["tools", "stats", "tagDefs", "zones", "directors", "entities", "factions"]);
const rootFields = new Set([
  "name",
  "year",
  "history",
  "historySettings",
  "tutorial",
  "events",
  "messageRoutes",
  "messageDebug",
  "signals",
]);

function integer(value: unknown, min: number, max: number): value is number {
  return Number.isInteger(value) && Number(value) >= min && Number(value) <= max;
}

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateOperation(kind: string, resourceKey: string, payload: unknown) {
  if (!operationKinds.has(kind) || !/^[A-Za-z][A-Za-z0-9:_-]{1,179}$/.test(resourceKey)) {
    throw new ConvexError({ code: "invalid_operation" });
  }
  const encoded = new TextEncoder().encode(JSON.stringify(payload));
  if (encoded.length > 600_000) throw new ConvexError({ code: "operation_too_large" });
  if (!object(payload)) throw new ConvexError({ code: "invalid_operation_payload" });
  if (kind === "setRecord" || kind === "deleteRecord") {
    if (!recordCollections.has(String(payload.collection)) || !/^[A-Za-z0-9_-]{1,100}$/.test(String(payload.id))) {
      throw new ConvexError({ code: "invalid_record_operation" });
    }
    if (resourceKey !== `${payload.collection}:${payload.id}`) {
      throw new ConvexError({ code: "resource_key_mismatch" });
    }
    if (kind === "setRecord" && !object(payload.value)) {
      throw new ConvexError({ code: "invalid_record_value" });
    }
  } else if (kind === "paintZoneCells") {
    const zoneId = String(payload.zoneId ?? "");
    const add = payload.add;
    const remove = payload.remove;
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(zoneId) || resourceKey !== `zones:${zoneId}:cells`) {
      throw new ConvexError({ code: "invalid_zone_operation" });
    }
    if (!Array.isArray(add) || !Array.isArray(remove) || add.length + remove.length > 1000) {
      throw new ConvexError({ code: "invalid_zone_cells" });
    }
    if (![...add, ...remove].every((cell) => integer(cell, 0, 2815))) {
      throw new ConvexError({ code: "invalid_zone_cells" });
    }
  } else if (kind === "setRoot") {
    const field = String(payload.field ?? "");
    if (!rootFields.has(field) || resourceKey !== `root:${field}`) {
      throw new ConvexError({ code: "invalid_root_operation" });
    }
  } else if (kind === "renameProject") {
    if (resourceKey !== "root:name" || typeof payload.name !== "string" || !payload.name.trim()) {
      throw new ConvexError({ code: "invalid_project_name" });
    }
  }
}

export const submitOperation = mutation({
  args: {
    publicId: v.string(),
    token: v.string(),
    sessionId: v.string(),
    opId: v.string(),
    kind: v.string(),
    resourceKey: v.string(),
    expectedVersion: v.number(),
    payload: v.any(),
  },
  handler: async (ctx, args) => {
    safeSessionId(args.sessionId);
    safeOpId(args.opId);
    if (!integer(args.expectedVersion, 0, 1_000_000_000)) {
      throw new ConvexError({ code: "invalid_resource_version" });
    }
    validateOperation(args.kind, args.resourceKey, args.payload);
    const { project, capability } = await requireAccess(ctx, args.publicId, args.token);
    requireEditor(capability.role);
    if (project.simulationStatus !== "paused") throw new ConvexError({ code: "pause_before_editing" });
    const duplicate = await ctx.db
      .query("projectOperations")
      .withIndex("by_project_op", (q) => q.eq("projectId", project._id).eq("opId", args.opId))
      .unique();
    if (duplicate) {
      return {
        status: "duplicate" as const,
        revision: duplicate.sequence,
        version: duplicate.resultingVersion,
      };
    }
    if (project.currentRevision - project.snapshotRevision >= 1000) {
      throw new ConvexError({ code: "checkpoint_required" });
    }
    const current = await ctx.db
      .query("resourceVersions")
      .withIndex("by_project_resource", (q) =>
        q.eq("projectId", project._id).eq("resourceKey", args.resourceKey),
      )
      .unique();
    const currentVersion = current?.version ?? 0;
    const mergeable = args.kind === "paintZoneCells";
    if (!mergeable && args.expectedVersion !== currentVersion) {
      return {
        status: "conflict" as const,
        revision: project.currentRevision,
        version: currentVersion,
      };
    }
    const nextVersion = currentVersion + 1;
    const now = Date.now();
    if (current) {
      await ctx.db.patch(current._id, {
        version: nextVersion,
        deleted: args.kind === "deleteRecord",
        updatedAt: now,
        updatedBy: args.sessionId,
      });
    } else {
      const resourceCount = await ctx.db
        .query("resourceVersions")
        .withIndex("by_project_resource", (q) => q.eq("projectId", project._id))
        .take(MAX_RESOURCE_VERSIONS);
      if (resourceCount.length >= MAX_RESOURCE_VERSIONS) {
        throw new ConvexError({ code: "project_resource_limit_reached" });
      }
      await ctx.db.insert("resourceVersions", {
        projectId: project._id,
        resourceKey: args.resourceKey,
        version: nextVersion,
        deleted: args.kind === "deleteRecord",
        updatedAt: now,
        updatedBy: args.sessionId,
      });
    }
    const sequence = project.currentRevision + 1;
    await ctx.db.insert("projectOperations", {
      projectId: project._id,
      sequence,
      opId: args.opId,
      sessionId: args.sessionId,
      kind: args.kind,
      resourceKey: args.resourceKey,
      expectedVersion: args.expectedVersion,
      resultingVersion: nextVersion,
      payload: args.payload,
      createdAt: now,
    });
    const patch: {
      currentRevision: number;
      updatedAt: number;
      name?: string;
      simulationSnapshotId?: undefined;
      simulationSourceRevision?: undefined;
      simulationTick?: number;
    } = {
      currentRevision: sequence,
      updatedAt: now,
    };
    if (args.kind === "renameProject" && object(args.payload)) patch.name = String(args.payload.name).trim().slice(0, 100);
    const staleSimulationFrame = project.simulationSnapshotId;
    if (staleSimulationFrame) {
      patch.simulationSnapshotId = undefined;
      patch.simulationSourceRevision = undefined;
      patch.simulationTick = 0;
    }
    await ctx.db.patch(project._id, patch);
    if (staleSimulationFrame && staleSimulationFrame !== project.currentSnapshotId) {
      await ctx.scheduler.runAfter(0, internal.projects.deleteDetachedSnapshot, {
        projectId: project._id,
        revisionId: staleSimulationFrame,
      });
    }
    return { status: "accepted" as const, revision: sequence, version: nextVersion };
  },
});

export const tail = query({
  args: { publicId: v.string(), token: v.string(), after: v.number() },
  handler: async (ctx, args) => {
    const { project, capability } = await requireAccess(ctx, args.publicId, args.token);
    if (!integer(args.after, 0, 1_000_000_000)) throw new ConvexError({ code: "invalid_revision" });
    if (args.after < project.snapshotRevision) {
      return {
        role: capability.role,
        revision: project.currentRevision,
        snapshotRevision: project.snapshotRevision,
        simulationStatus: project.simulationStatus,
        needsBootstrap: true,
        truncated: false,
        nextAfter: project.snapshotRevision,
        operations: [],
      };
    }
    const operations = await ctx.db
      .query("projectOperations")
      .withIndex("by_project_sequence", (q) => q.eq("projectId", project._id).gt("sequence", args.after))
      .take(OPERATION_PAGE_SIZE + 1);
    const page = operations.slice(0, OPERATION_PAGE_SIZE);
    return {
      role: capability.role,
      revision: project.currentRevision,
      snapshotRevision: project.snapshotRevision,
      simulationStatus: project.simulationStatus,
      needsBootstrap: false,
      truncated: operations.length > OPERATION_PAGE_SIZE,
      nextAfter: page.length ? page[page.length - 1].sequence : args.after,
      operations: page.map((operation) => ({
        sequence: operation.sequence,
        opId: operation.opId,
        sessionId: operation.sessionId,
        kind: operation.kind,
        resourceKey: operation.resourceKey,
        resultingVersion: operation.resultingVersion,
        payload: operation.payload,
        createdAt: operation.createdAt,
      })),
    };
  },
});

export const updatePresence = mutation({
  args: {
    publicId: v.string(),
    token: v.string(),
    sessionId: v.string(),
    displayName: v.string(),
    color: v.string(),
    view: v.string(),
    editingKind: v.optional(v.string()),
    editingId: v.optional(v.string()),
    pointerX: v.optional(v.number()),
    pointerY: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    safeSessionId(args.sessionId);
    const { project, capability } = await requireAccess(ctx, args.publicId, args.token);
    const displayName = args.displayName.trim().slice(0, 40) || "Guest";
    const color = /^#[0-9a-fA-F]{6}$/.test(args.color) ? args.color : "#8b949e";
    const view = /^[A-Za-z0-9_-]{1,40}$/.test(args.view) ? args.view : "board";
    const editingKind = args.editingKind?.slice(0, 40);
    const editingId = args.editingId?.slice(0, 100);
    const pointerX = args.pointerX === undefined ? undefined : Math.max(0, Math.min(1, args.pointerX));
    const pointerY = args.pointerY === undefined ? undefined : Math.max(0, Math.min(1, args.pointerY));
    const existing = await ctx.db
      .query("presence")
      .withIndex("by_project_session", (q) =>
        q.eq("projectId", project._id).eq("sessionId", args.sessionId),
      )
      .unique();
    const value = {
      role: capability.role,
      displayName,
      color,
      view,
      editingKind,
      editingId,
      pointerX,
      pointerY,
      lastSeen: Date.now(),
    };
    if (existing) {
      await ctx.db.patch(existing._id, value);
    } else {
      const activePresence = await ctx.db
        .query("presence")
        .withIndex("by_project_seen", (q) =>
          q.eq("projectId", project._id).gt("lastSeen", Date.now() - 120_000),
        )
        .take(MAX_PROJECT_PRESENCE);
      if (activePresence.length >= MAX_PROJECT_PRESENCE) {
        throw new ConvexError({ code: "project_presence_limit_reached" });
      }
      await ctx.db.insert("presence", { projectId: project._id, sessionId: args.sessionId, ...value });
    }
    return { ok: true };
  },
});

export const listPresence = query({
  args: { publicId: v.string(), token: v.string() },
  handler: async (ctx, args) => {
    const { project } = await requireAccess(ctx, args.publicId, args.token);
    const cutoff = Date.now() - 45_000;
    const entries = await ctx.db
      .query("presence")
      .withIndex("by_project_seen", (q) => q.eq("projectId", project._id).gt("lastSeen", cutoff))
      .take(MAX_PROJECT_PRESENCE);
    return entries.map((entry) => ({
      sessionId: entry.sessionId,
      role: entry.role,
      displayName: entry.displayName,
      color: entry.color,
      view: entry.view,
      editingKind: entry.editingKind,
      editingId: entry.editingId,
      pointerX: entry.pointerX,
      pointerY: entry.pointerY,
      lastSeen: entry.lastSeen,
    }));
  },
});

export const cleanupPresence = internalMutation({
  args: {},
  handler: async (ctx) => {
    const stale = await ctx.db
      .query("presence")
      .withIndex("by_last_seen", (q) => q.lt("lastSeen", Date.now() - 120_000))
      .take(1000);
    for (const entry of stale) await ctx.db.delete(entry._id);
    return stale.length;
  },
});
