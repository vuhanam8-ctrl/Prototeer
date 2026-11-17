import { mutation, query, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { v, ConvexError } from "convex/values";
import { requireAccess, requireEditor, safeSessionId } from "./lib/access";
import { insertSnapshot } from "./lib/snapshots";

const LEASE_MS = 20_000;

function validTick(value: number) {
  return Number.isInteger(value) && value >= 0 && value <= 1_000_000_000;
}

function validGeneration(value: number) {
  return Number.isInteger(value) && value >= 0 && value <= 1_000_000_000;
}

export const start = mutation({
  args: {
    publicId: v.string(),
    token: v.string(),
    sessionId: v.string(),
    expectedProjectRevision: v.number(),
  },
  handler: async (ctx, args) => {
    safeSessionId(args.sessionId);
    if (!validGeneration(args.expectedProjectRevision)) {
      throw new ConvexError({ code: "invalid_project_revision" });
    }
    const { project, capability } = await requireAccess(ctx, args.publicId, args.token);
    requireEditor(capability.role);
    if (project.currentRevision !== args.expectedProjectRevision) {
      return { status: "conflict" as const, revision: project.currentRevision };
    }
    const now = Date.now();
    if (
      project.simulationStatus === "running" &&
      project.simulationController !== args.sessionId &&
      (project.simulationLeaseUntil ?? 0) > now
    ) {
      return { status: "controlled" as const, generation: project.simulationGeneration };
    }
    const generation = project.simulationGeneration + 1;
    const oldFrame = project.simulationSnapshotId;
    await ctx.db.patch(project._id, {
      simulationStatus: "running",
      simulationGeneration: generation,
      simulationController: args.sessionId,
      simulationLeaseUntil: now + LEASE_MS,
      simulationTick: 0,
      simulationSnapshotId: undefined,
      simulationSourceRevision: project.currentRevision,
    });
    if (oldFrame && oldFrame !== project.currentSnapshotId) {
      await ctx.scheduler.runAfter(0, internal.projects.deleteDetachedSnapshot, {
        projectId: project._id,
        revisionId: oldFrame,
      });
    }
    return { status: "started" as const, generation, revision: project.currentRevision };
  },
});

export const heartbeat = mutation({
  args: {
    publicId: v.string(),
    token: v.string(),
    sessionId: v.string(),
    generation: v.number(),
  },
  handler: async (ctx, args) => {
    safeSessionId(args.sessionId);
    if (!validGeneration(args.generation)) throw new ConvexError({ code: "invalid_simulation_generation" });
    const { project, capability } = await requireAccess(ctx, args.publicId, args.token);
    requireEditor(capability.role);
    if (
      project.simulationStatus !== "running" ||
      project.simulationController !== args.sessionId ||
      project.simulationGeneration !== args.generation
    ) {
      throw new ConvexError({ code: "simulation_lease_lost" });
    }
    const leaseUntil = Date.now() + LEASE_MS;
    await ctx.db.patch(project._id, { simulationLeaseUntil: leaseUntil });
    return { leaseUntil };
  },
});

export const publishFrame = mutation({
  args: {
    publicId: v.string(),
    token: v.string(),
    sessionId: v.string(),
    generation: v.number(),
    tick: v.number(),
    chunks: v.array(v.string()),
    byteLength: v.number(),
  },
  handler: async (ctx, args) => {
    safeSessionId(args.sessionId);
    if (!validTick(args.tick)) throw new ConvexError({ code: "invalid_simulation_tick" });
    if (!validGeneration(args.generation)) throw new ConvexError({ code: "invalid_simulation_generation" });
    const { project, capability } = await requireAccess(ctx, args.publicId, args.token);
    requireEditor(capability.role);
    if (
      project.simulationStatus !== "running" ||
      project.simulationController !== args.sessionId ||
      project.simulationGeneration !== args.generation ||
      (project.simulationLeaseUntil ?? 0) < Date.now()
    ) {
      throw new ConvexError({ code: "simulation_lease_lost" });
    }
    if (args.tick < project.simulationTick) throw new ConvexError({ code: "stale_simulation_frame" });
    const snapshotId = await insertSnapshot(ctx, {
      projectId: project._id,
      revision: project.currentRevision,
      kind: "simulation",
      reason: `Frame ${args.tick}`,
      sessionId: args.sessionId,
      chunks: args.chunks,
      byteLength: args.byteLength,
    });
    const oldFrame = project.simulationSnapshotId;
    await ctx.db.patch(project._id, {
      simulationSnapshotId: snapshotId,
      simulationTick: args.tick,
      simulationLeaseUntil: Date.now() + LEASE_MS,
    });
    if (oldFrame && oldFrame !== project.currentSnapshotId) {
      await ctx.scheduler.runAfter(0, internal.projects.deleteDetachedSnapshot, {
        projectId: project._id,
        revisionId: oldFrame,
      });
    }
    return { tick: args.tick };
  },
});

export const pause = mutation({
  args: { publicId: v.string(), token: v.string(), sessionId: v.string() },
  handler: async (ctx, args) => {
    safeSessionId(args.sessionId);
    const { project, capability } = await requireAccess(ctx, args.publicId, args.token);
    requireEditor(capability.role);
    await ctx.db.patch(project._id, {
      simulationStatus: "paused",
      simulationController: undefined,
      simulationLeaseUntil: undefined,
    });
    return { status: "paused" as const, tick: project.simulationTick };
  },
});

export const reset = mutation({
  args: { publicId: v.string(), token: v.string(), sessionId: v.string() },
  handler: async (ctx, args) => {
    safeSessionId(args.sessionId);
    const { project, capability } = await requireAccess(ctx, args.publicId, args.token);
    requireEditor(capability.role);
    const oldFrame = project.simulationSnapshotId;
    await ctx.db.patch(project._id, {
      simulationStatus: "paused",
      simulationController: undefined,
      simulationLeaseUntil: undefined,
      simulationTick: 0,
      simulationGeneration: project.simulationGeneration + 1,
      simulationSnapshotId: undefined,
      simulationSourceRevision: undefined,
    });
    if (oldFrame && oldFrame !== project.currentSnapshotId) {
      await ctx.scheduler.runAfter(0, internal.projects.deleteDetachedSnapshot, {
        projectId: project._id,
        revisionId: oldFrame,
      });
    }
    return { status: "reset" as const };
  },
});

export const state = query({
  args: { publicId: v.string(), token: v.string() },
  handler: async (ctx, args) => {
    const { project } = await requireAccess(ctx, args.publicId, args.token);
    let chunks: string[] = [];
    if (project.simulationSnapshotId) {
      const rows = await ctx.db
        .query("revisionChunks")
        .withIndex("by_revision_index", (q) => q.eq("revisionId", project.simulationSnapshotId!))
        .collect();
      chunks = rows.sort((a, b) => a.index - b.index).map((row) => row.json);
    }
    return {
      status: project.simulationStatus,
      generation: project.simulationGeneration,
      controllerSessionId: project.simulationController,
      leaseUntil: project.simulationLeaseUntil,
      sourceRevision: project.simulationSourceRevision,
      tick: project.simulationTick,
      chunks,
    };
  },
});

export const cleanupExpired = internalMutation({
  args: {},
  handler: async (ctx) => {
    const projects = await ctx.db
      .query("projects")
      .withIndex("by_simulation_lease", (q) =>
        q.eq("simulationStatus", "running").lt("simulationLeaseUntil", Date.now()),
      )
      .take(500);
    let changed = 0;
    for (const project of projects) {
      await ctx.db.patch(project._id, {
        simulationStatus: "paused",
        simulationController: undefined,
        simulationLeaseUntil: undefined,
      });
      changed++;
    }
    return changed;
  },
});
