import { internalMutation, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { v, ConvexError } from "convex/values";
import { digestToken, requireAccess, requireEditor, requireOwner, requireUnusedTokenDigest, safeSessionId } from "./lib/access";
import { boardSnapshotFields, insertBoard } from "./lib/boards";
import { deleteSnapshot, insertSnapshot } from "./lib/snapshots";

const OPEN_OPERATION_LIMIT = 2;
const CHECKPOINT_PRUNE_LIMIT = 16;
const MAX_CAPABILITIES_PER_PROJECT = 100;
const MAX_RESOURCE_VERSIONS = 4_000;

const roleValidator = v.union(v.literal("owner"), v.literal("editor"), v.literal("viewer"));

export const create = mutation({
  args: {
    ...boardSnapshotFields,
    ownerToken: v.string(),
    editorToken: v.string(),
    viewerToken: v.string(),
    sessionId: v.string(),
  },
  handler: async (ctx, args) => {
    const digests = await Promise.all([
      digestToken(args.ownerToken),
      digestToken(args.editorToken),
      digestToken(args.viewerToken),
    ]);
    if (new Set(digests).size !== 3) throw new ConvexError({ code: "access_keys_must_be_unique" });
    await Promise.all(digests.map((digest) => requireUnusedTokenDigest(ctx, digest)));
    const { projectId, updatedAt } = await insertBoard(ctx, args, args.sessionId);
    for (const [index, role] of (["owner", "editor", "viewer"] as const).entries()) {
      await ctx.db.insert("projectCapabilities", {
        projectId,
        tokenDigest: digests[index],
        role,
        label: role === "owner" ? "Recovery owner" : `Default ${role} link`,
        createdAt: updatedAt,
      });
    }
    return { publicId: args.publicId, role: "owner" as const, revision: 0 };
  },
});

export const open = query({
  args: { publicId: v.string(), token: v.string() },
  handler: async (ctx, args) => {
    const { project, capability } = await requireAccess(ctx, args.publicId, args.token);
    if (!project.currentSnapshotId) throw new ConvexError({ code: "snapshot_unavailable" });
    const chunks = await ctx.db
      .query("revisionChunks")
      .withIndex("by_revision_index", (q) => q.eq("revisionId", project.currentSnapshotId!))
      .collect();
    const operations = await ctx.db
      .query("projectOperations")
      .withIndex("by_project_sequence", (q) =>
        q.eq("projectId", project._id).gt("sequence", project.snapshotRevision),
      )
      .take(OPEN_OPERATION_LIMIT + 1);
    const versions = await ctx.db
      .query("resourceVersions")
      .withIndex("by_project_resource", (q) => q.eq("projectId", project._id))
      .take(MAX_RESOURCE_VERSIONS + 1);
    if (versions.length > MAX_RESOURCE_VERSIONS) {
      throw new ConvexError({ code: "project_resource_limit_reached" });
    }
    const operationPage = operations.slice(0, OPEN_OPERATION_LIMIT);
    return {
      project: {
        publicId: project.publicId,
        name: project.name,
        formatVersion: project.formatVersion,
        revision: project.currentRevision,
        snapshotRevision: project.snapshotRevision,
        updatedAt: project.updatedAt,
        simulationStatus: project.simulationStatus,
      },
      role: capability.role,
      chunks: chunks.sort((a, b) => a.index - b.index).map((chunk) => chunk.json),
      operations: operationPage.map((operation) => ({
        sequence: operation.sequence,
        opId: operation.opId,
        sessionId: operation.sessionId,
        kind: operation.kind,
        resourceKey: operation.resourceKey,
        expectedVersion: operation.expectedVersion,
        resultingVersion: operation.resultingVersion,
        payload: operation.payload,
        createdAt: operation.createdAt,
      })),
      operationsTruncated: operations.length > OPEN_OPERATION_LIMIT,
      nextOperationAfter:
        operationPage.length ? operationPage[operationPage.length - 1].sequence : project.snapshotRevision,
      versions: Object.fromEntries(versions.map((entry) => [entry.resourceKey, entry.version])),
    };
  },
});

export const checkpoint = mutation({
  args: {
    publicId: v.string(),
    token: v.string(),
    sessionId: v.string(),
    expectedRevision: v.number(),
    reason: v.string(),
    chunks: v.array(v.string()),
    byteLength: v.number(),
  },
  handler: async (ctx, args) => {
    safeSessionId(args.sessionId);
    const { project, capability } = await requireAccess(ctx, args.publicId, args.token);
    requireEditor(capability.role);
    if (project.simulationStatus !== "paused") throw new ConvexError({ code: "pause_before_editing" });
    if (project.currentRevision !== args.expectedRevision) {
      return { status: "conflict" as const, revision: project.currentRevision };
    }
    const snapshotId = await insertSnapshot(ctx, {
      projectId: project._id,
      revision: project.currentRevision,
      kind: "project",
      reason: args.reason || "Saved",
      sessionId: args.sessionId,
      chunks: args.chunks,
      byteLength: args.byteLength,
    });
    await ctx.db.patch(project._id, {
      currentSnapshotId: snapshotId,
      snapshotRevision: project.currentRevision,
      updatedAt: Date.now(),
    });
    await ctx.scheduler.runAfter(0, internal.projects.pruneCheckpointedOperations, {
      projectId: project._id,
      throughSequence: project.currentRevision,
    });
    await ctx.scheduler.runAfter(0, internal.projects.pruneProjectRevisions, {
      projectId: project._id,
    });
    return { status: "saved" as const, revision: project.currentRevision };
  },
});

export const listRevisions = query({
  args: { publicId: v.string(), token: v.string() },
  handler: async (ctx, args) => {
    const { project } = await requireAccess(ctx, args.publicId, args.token);
    const revisions = await ctx.db
      .query("projectRevisions")
      .withIndex("by_project_kind", (q) => q.eq("projectId", project._id).eq("kind", "project"))
      .order("desc")
      .take(20);
    return revisions
      .map((revision) => ({
        id: revision._id,
        revision: revision.revision,
        reason: revision.reason,
        createdAt: revision.createdAt,
        byteLength: revision.byteLength,
      }));
  },
});

export const restoreRevision = mutation({
  args: {
    publicId: v.string(),
    token: v.string(),
    sessionId: v.string(),
    revisionId: v.id("projectRevisions"),
  },
  handler: async (ctx, args) => {
    safeSessionId(args.sessionId);
    const { project, capability } = await requireAccess(ctx, args.publicId, args.token);
    requireOwner(capability.role);
    if (project.simulationStatus !== "paused") throw new ConvexError({ code: "pause_before_editing" });
    const revision = await ctx.db.get(args.revisionId);
    if (!revision || revision.projectId !== project._id || revision.kind !== "project") {
      throw new ConvexError({ code: "revision_not_found" });
    }
    const sourceChunks = await ctx.db
      .query("revisionChunks")
      .withIndex("by_revision_index", (q) => q.eq("revisionId", revision._id))
      .collect();
    const chunks = sourceChunks.sort((a, b) => a.index - b.index).map((chunk) => chunk.json);
    const nextRevision = project.currentRevision + 1;
    const staleSimulationFrame = project.simulationSnapshotId;
    const snapshotId = await insertSnapshot(ctx, {
      projectId: project._id,
      revision: nextRevision,
      kind: "project",
      reason: `Restored revision ${revision.revision}`,
      sessionId: args.sessionId,
      chunks,
      byteLength: revision.byteLength,
    });
    const versions = await ctx.db
      .query("resourceVersions")
      .withIndex("by_project_resource", (q) => q.eq("projectId", project._id))
      .take(MAX_RESOURCE_VERSIONS + 1);
    for (const version of versions) await ctx.db.delete(version._id);
    await ctx.db.patch(project._id, {
      currentRevision: nextRevision,
      snapshotRevision: nextRevision,
      currentSnapshotId: snapshotId,
      updatedAt: Date.now(),
      simulationSnapshotId: undefined,
      simulationSourceRevision: undefined,
      simulationTick: 0,
    });
    if (staleSimulationFrame && staleSimulationFrame !== project.currentSnapshotId) {
      await ctx.scheduler.runAfter(0, internal.projects.deleteDetachedSnapshot, {
        projectId: project._id,
        revisionId: staleSimulationFrame,
      });
    }
    await ctx.scheduler.runAfter(0, internal.projects.pruneCheckpointedOperations, {
      projectId: project._id,
      throughSequence: project.currentRevision,
    });
    await ctx.scheduler.runAfter(0, internal.projects.pruneProjectRevisions, {
      projectId: project._id,
    });
    return { revision: nextRevision };
  },
});

export const createCapability = mutation({
  args: {
    publicId: v.string(),
    token: v.string(),
    newToken: v.string(),
    role: roleValidator,
    label: v.string(),
  },
  handler: async (ctx, args) => {
    const { project, capability } = await requireAccess(ctx, args.publicId, args.token);
    requireOwner(capability.role);
    if (project.workspaceId) throw new ConvexError({ code: "project_invite_required" });
    if (args.role === "owner") throw new ConvexError({ code: "owner_links_cannot_be_shared" });
    const grants = await ctx.db
      .query("projectCapabilities")
      .withIndex("by_project", (q) => q.eq("projectId", project._id))
      .take(MAX_CAPABILITIES_PER_PROJECT);
    if (grants.length >= MAX_CAPABILITIES_PER_PROJECT) {
      throw new ConvexError({ code: "access_link_limit_reached" });
    }
    const tokenDigest = await digestToken(args.newToken);
    await requireUnusedTokenDigest(ctx, tokenDigest);
    const id = await ctx.db.insert("projectCapabilities", {
      projectId: project._id,
      tokenDigest,
      role: args.role,
      label: args.label.trim().slice(0, 60) || `${args.role} link`,
      createdAt: Date.now(),
    });
    return { id };
  },
});

export const listCapabilities = query({
  args: { publicId: v.string(), token: v.string() },
  handler: async (ctx, args) => {
    const { project, capability } = await requireAccess(ctx, args.publicId, args.token);
    requireOwner(capability.role);
    if (project.workspaceId) throw new ConvexError({ code: "project_invite_required" });
    const grants = await ctx.db
      .query("projectCapabilities")
      .withIndex("by_project", (q) => q.eq("projectId", project._id))
      .take(MAX_CAPABILITIES_PER_PROJECT);
    return grants.map((grant) => ({
      id: grant._id,
      role: grant.role,
      label: grant.label,
      createdAt: grant.createdAt,
      revokedAt: grant.revokedAt,
    }));
  },
});

export const revokeCapability = mutation({
  args: { publicId: v.string(), token: v.string(), capabilityId: v.id("projectCapabilities") },
  handler: async (ctx, args) => {
    const { project, capability } = await requireAccess(ctx, args.publicId, args.token);
    requireOwner(capability.role);
    if (project.workspaceId) throw new ConvexError({ code: "project_invite_required" });
    const target = await ctx.db.get(args.capabilityId);
    if (!target || target.projectId !== project._id) throw new ConvexError({ code: "link_not_found" });
    if (target.role === "owner") throw new ConvexError({ code: "owner_link_cannot_be_revoked" });
    await ctx.db.patch(target._id, { revokedAt: Date.now() });
    return { revoked: true };
  },
});

export const pruneCheckpointedOperations = internalMutation({
  args: { projectId: v.id("projects"), throughSequence: v.number() },
  handler: async (ctx, args): Promise<number> => {
    const operations = await ctx.db
      .query("projectOperations")
      .withIndex("by_project_sequence", (q) =>
        q.eq("projectId", args.projectId).lte("sequence", args.throughSequence),
      )
      .take(CHECKPOINT_PRUNE_LIMIT);
    for (const operation of operations) await ctx.db.delete(operation._id);
    if (operations.length === CHECKPOINT_PRUNE_LIMIT) {
      await ctx.scheduler.runAfter(50, internal.projects.pruneCheckpointedOperations, args);
    }
    return operations.length;
  },
});

export const pruneProjectRevisions = internalMutation({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args): Promise<number> => {
    const revisions = await ctx.db
      .query("projectRevisions")
      .withIndex("by_project_kind", (q) => q.eq("projectId", args.projectId).eq("kind", "project"))
      .order("desc")
      .take(21);
    if (revisions.length <= 20) return 0;
    const project = await ctx.db.get(args.projectId);
    const oldestExcess = revisions[20];
    if (project?.currentSnapshotId === oldestExcess._id) return 0;
    await deleteSnapshot(ctx, oldestExcess._id);
    await ctx.scheduler.runAfter(100, internal.projects.pruneProjectRevisions, args);
    return 1;
  },
});

export const deleteDetachedSnapshot = internalMutation({
  args: {
    projectId: v.id("projects"),
    revisionId: v.id("projectRevisions"),
  },
  handler: async (ctx, args) => {
    const [project, revision] = await Promise.all([
      ctx.db.get(args.projectId),
      ctx.db.get(args.revisionId),
    ]);
    if (!revision || revision.projectId !== args.projectId) return false;
    if (
      project?.currentSnapshotId === args.revisionId ||
      project?.simulationSnapshotId === args.revisionId
    ) {
      return false;
    }
    await deleteSnapshot(ctx, args.revisionId);
    return true;
  },
});
