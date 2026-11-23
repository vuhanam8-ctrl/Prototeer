import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import {
  digestToken,
  findWorkspaceCapability,
  requireAccess,
  requireEditor,
  requireOwner,
  requireUnusedTokenDigest,
  safeSessionId,
} from "./lib/access";
import { boardSnapshotFields, findBoard, insertBoard, requireBoardFormat, requireNewPublicId, safeBoardPreview, safeName } from "./lib/boards";
import { deleteSnapshot, insertSnapshot } from "./lib/snapshots";

const MAX_BOARDS = 50;
const MAX_ACCESS_LINKS = 100;
const credentials = { publicId: v.string(), token: v.string() };

function findWorkspace(ctx: QueryCtx | MutationCtx, publicId: string) {
  return ctx.db.query("workspaces")
    .withIndex("by_public_id", (q) => q.eq("publicId", publicId))
    .unique();
}

async function requireWorkspaceAccess(ctx: QueryCtx | MutationCtx, publicId: string, token: string) {
  if (!/^[A-Za-z0-9_-]{20,80}$/.test(publicId)) throw new ConvexError({ code: "project_not_found" });
  const tokenDigest = await digestToken(token);
  const [workspace, capability] = await Promise.all([
    findWorkspace(ctx, publicId),
    findWorkspaceCapability(ctx, tokenDigest),
  ]);
  if (!workspace || capability?.workspaceId !== workspace._id || capability.revokedAt !== undefined) {
    throw new ConvexError({ code: "access_denied" });
  }
  return { workspace, capability };
}

const boardInfo = ({ publicId, name, updatedAt, preview }: Pick<Doc<"projects">, "publicId" | "name" | "updatedAt" | "preview">) => ({
  publicId, name, updatedAt, preview,
});

function getBoards(ctx: MutationCtx | QueryCtx, workspaceId: Id<"workspaces">) {
  return ctx.db.query("projects")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .take(MAX_BOARDS);
}

function getCapabilities(ctx: MutationCtx | QueryCtx, workspaceId: Id<"workspaces">) {
  return ctx.db.query("workspaceCapabilities")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .take(MAX_ACCESS_LINKS);
}

export const create = mutation({
  args: {
    publicId: v.string(),
    ownerToken: v.string(),
    name: v.string(),
    sessionId: v.string(),
    board: v.object(boardSnapshotFields),
  },
  handler: async (ctx, args) => {
    requireNewPublicId(args.publicId);
    safeSessionId(args.sessionId);
    const name = safeName(args.name);
    const existing = await findWorkspace(ctx, args.publicId);
    if (existing) {
      const { capability } = await requireWorkspaceAccess(ctx, args.publicId, args.ownerToken);
      requireOwner(capability.role);
      const board = await findBoard(ctx, args.board.publicId);
      if (!board || board.workspaceId !== existing._id) {
        throw new ConvexError({ code: "project_id_unavailable" });
      }
      return { publicId: existing.publicId, name: existing.name, role: "owner" as const, board: boardInfo(board) };
    }
    const tokenDigest = await digestToken(args.ownerToken);
    await requireUnusedTokenDigest(ctx, tokenDigest);
    const createdAt = Date.now();
    const workspaceId = await ctx.db.insert("workspaces", { publicId: args.publicId, name, createdAt });
    await ctx.db.insert("workspaceCapabilities", {
      workspaceId, tokenDigest, role: "owner", label: "Recovery owner", createdAt,
    });
    const board = await insertBoard(ctx, args.board, args.sessionId, workspaceId);
    return { publicId: args.publicId, name, role: "owner" as const, board: boardInfo(board) };
  },
});

export const open = query({
  args: credentials,
  handler: async (ctx, args) => {
    const { workspace, capability } = await requireWorkspaceAccess(ctx, args.publicId, args.token);
    return {
      publicId: workspace.publicId,
      name: workspace.name,
      role: capability.role,
      boards: (await getBoards(ctx, workspace._id)).map(boardInfo),
    };
  },
});

export const addBoard = mutation({
  args: {
    ...credentials,
    sessionId: v.string(),
    board: v.object(boardSnapshotFields),
  },
  handler: async (ctx, args) => {
    const { workspace, capability } = await requireWorkspaceAccess(ctx, args.publicId, args.token);
    requireEditor(capability.role);
    safeSessionId(args.sessionId);
    const existing = await findBoard(ctx, args.board.publicId);
    if (existing) {
      if (existing.workspaceId !== workspace._id) throw new ConvexError({ code: "project_id_unavailable" });
      return boardInfo(existing);
    }
    if ((await getBoards(ctx, workspace._id)).length >= MAX_BOARDS) {
      throw new ConvexError({ code: "board_limit_reached" });
    }
    return boardInfo(await insertBoard(ctx, args.board, args.sessionId, workspace._id));
  },
});

export const updateDraftBoard = mutation({
  args: {
    ...credentials,
    sessionId: v.string(),
    board: v.object(boardSnapshotFields),
  },
  handler: async (ctx, args) => {
    const { workspace, capability } = await requireWorkspaceAccess(ctx, args.publicId, args.token);
    requireOwner(capability.role);
    if (workspace.publishedAt !== undefined) throw new ConvexError({ code: "project_already_shared" });
    safeSessionId(args.sessionId);
    requireBoardFormat(args.board.formatVersion);
    const board = await findBoard(ctx, args.board.publicId);
    if (!board || board.workspaceId !== workspace._id) throw new ConvexError({ code: "project_not_found" });
    const previousSnapshotId = board.currentSnapshotId;
    if (board.currentRevision !== 0 || board.simulationGeneration !== 0 || !previousSnapshotId) {
      throw new ConvexError({ code: "draft_board_changed" });
    }
    const currentSnapshotId = await insertSnapshot(ctx, {
      projectId: board._id,
      revision: 0,
      kind: "project",
      reason: "Updated before sharing",
      sessionId: args.sessionId,
      chunks: args.board.chunks,
      byteLength: args.board.byteLength,
    });
    const name = safeName(args.board.name);
    const preview = safeBoardPreview(args.board.preview);
    const updatedAt = Date.now();
    await ctx.db.patch(board._id, {
      currentSnapshotId, name, updatedAt, preview, formatVersion: args.board.formatVersion,
    });
    await deleteSnapshot(ctx, previousSnapshotId);
    return { publicId: board.publicId, name, updatedAt, preview };
  },
});

export const updatePreview = mutation({
  args: { ...credentials, expectedRevision: v.number(), preview: v.string() },
  handler: async (ctx, args) => {
    const { project, capability } = await requireAccess(ctx, args.publicId, args.token);
    if (!project.workspaceId) throw new ConvexError({ code: "project_not_found" });
    requireEditor(capability.role);
    if (project.currentRevision !== args.expectedRevision) return { status: "stale" as const };
    if (project.preview === args.preview) return { status: "unchanged" as const };
    await ctx.db.patch(project._id, { preview: safeBoardPreview(args.preview) });
    return { status: "saved" as const };
  },
});

export const createCapability = mutation({
  args: {
    ...credentials,
    newToken: v.string(),
    role: v.union(v.literal("viewer"), v.literal("editor")),
    label: v.string(),
    expectedBoardIds: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const { workspace, capability } = await requireWorkspaceAccess(ctx, args.publicId, args.token);
    requireOwner(capability.role);
    const tokenDigest = await digestToken(args.newToken);
    const existing = await findWorkspaceCapability(ctx, tokenDigest);
    if (existing) {
      if (existing.workspaceId === workspace._id && existing.role === args.role && existing.revokedAt === undefined) {
        return { id: existing._id };
      }
      throw new ConvexError({ code: "access_key_unavailable" });
    }
    if (args.expectedBoardIds) {
      const expected = new Set(args.expectedBoardIds);
      const boards = await getBoards(ctx, workspace._id);
      if (args.expectedBoardIds.length > MAX_BOARDS || expected.size !== args.expectedBoardIds.length ||
          expected.size !== boards.length ||
          boards.some((board) => !expected.has(board.publicId))) {
        throw new ConvexError({ code: "project_boards_changed" });
      }
    }
    if ((await getCapabilities(ctx, workspace._id)).length >= MAX_ACCESS_LINKS) {
      throw new ConvexError({ code: "access_link_limit_reached" });
    }
    await requireUnusedTokenDigest(ctx, tokenDigest);
    const id = await ctx.db.insert("workspaceCapabilities", {
      workspaceId: workspace._id,
      tokenDigest,
      role: args.role,
      label: args.label.trim().slice(0, 60) || `${args.role} link`,
      createdAt: Date.now(),
    });
    if (workspace.publishedAt === undefined) await ctx.db.patch(workspace._id, { publishedAt: Date.now() });
    return { id };
  },
});

export const listCapabilities = query({
  args: credentials,
  handler: async (ctx, args) => {
    const { workspace, capability } = await requireWorkspaceAccess(ctx, args.publicId, args.token);
    requireOwner(capability.role);
    return (await getCapabilities(ctx, workspace._id)).map(({ _id, role, label, createdAt, revokedAt }) => ({
      id: _id, role, label, createdAt, revokedAt,
    }));
  },
});

export const revokeCapability = mutation({
  args: { ...credentials, capabilityId: v.id("workspaceCapabilities") },
  handler: async (ctx, args) => {
    const { workspace, capability } = await requireWorkspaceAccess(ctx, args.publicId, args.token);
    requireOwner(capability.role);
    const target = await ctx.db.get(args.capabilityId);
    if (target?.workspaceId !== workspace._id) throw new ConvexError({ code: "link_not_found" });
    if (target.role === "owner") throw new ConvexError({ code: "owner_link_cannot_be_revoked" });
    if (target.revokedAt === undefined) await ctx.db.patch(target._id, { revokedAt: Date.now() });
    return { revoked: true };
  },
});
