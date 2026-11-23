import { ConvexError, v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { safeSessionId } from "./access";
import { insertSnapshot } from "./snapshots";

export const boardSnapshotFields = {
  publicId: v.string(),
  name: v.string(),
  formatVersion: v.number(),
  chunks: v.array(v.string()),
  byteLength: v.number(),
  preview: v.optional(v.string()),
};

type BoardSnapshot = {
  publicId: string;
  name: string;
  formatVersion: number;
  chunks: string[];
  byteLength: number;
  preview?: string;
};

export function safeBoardPreview(value?: string) {
  if (value !== undefined && (value.length > 64 * 44 || /[^0-9a-f]/.test(value))) {
    throw new ConvexError({ code: "invalid_board_preview" });
  }
  return value;
}

export function safeName(name: string) {
  const value = name.trim().slice(0, 100);
  if (!value) throw new ConvexError({ code: "project_name_required" });
  return value;
}

export function requireNewPublicId(value: string) {
  if (!/^[A-Za-z0-9_-]{20,80}$/.test(value)) {
    throw new ConvexError({ code: "invalid_project_id" });
  }
}

export function findBoard(ctx: QueryCtx | MutationCtx, publicId: string) {
  return ctx.db.query("projects")
    .withIndex("by_public_id", (q) => q.eq("publicId", publicId))
    .unique();
}

export function requireBoardFormat(version: number) {
  if (!Number.isInteger(version) || version < 1 || version > 100) {
    throw new ConvexError({ code: "invalid_project_format" });
  }
}

export async function insertBoard(
  ctx: MutationCtx,
  board: BoardSnapshot,
  sessionId: string,
  workspaceId?: Id<"workspaces">,
) {
  requireNewPublicId(board.publicId);
  safeSessionId(sessionId);
  requireBoardFormat(board.formatVersion);
  if (await findBoard(ctx, board.publicId)) throw new ConvexError({ code: "project_id_unavailable" });
  const name = safeName(board.name);
  const preview = safeBoardPreview(board.preview);
  const now = Date.now();
  const projectId = await ctx.db.insert("projects", {
    publicId: board.publicId,
    ...(workspaceId ? { workspaceId } : {}),
    name,
    ...(preview === undefined ? {} : { preview }),
    formatVersion: board.formatVersion,
    currentRevision: 0,
    snapshotRevision: 0,
    createdAt: now,
    updatedAt: now,
    simulationStatus: "paused",
    simulationGeneration: 0,
    simulationTick: 0,
  });
  const snapshotId = await insertSnapshot(ctx, {
    projectId,
    revision: 0,
    kind: "project",
    reason: "Created",
    sessionId,
    chunks: board.chunks,
    byteLength: board.byteLength,
  });
  await ctx.db.patch(projectId, { currentSnapshotId: snapshotId });
  return { projectId, publicId: board.publicId, name, updatedAt: now, preview };
}
