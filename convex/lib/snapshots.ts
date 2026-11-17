import { ConvexError } from "convex/values";
import type { MutationCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";

export const MAX_PROJECT_BYTES = 12 * 1024 * 1024;
export const MAX_CHUNK_BYTES = 700_000;
export const MAX_CHUNKS = 32;

export function validateChunks(chunks: string[], byteLength: number) {
  if (!Number.isInteger(byteLength) || byteLength < 2 || byteLength > MAX_PROJECT_BYTES) {
    throw new ConvexError({ code: "project_too_large" });
  }
  if (!Array.isArray(chunks) || chunks.length < 1 || chunks.length > MAX_CHUNKS) {
    throw new ConvexError({ code: "invalid_snapshot_chunks" });
  }
  let measured = 0;
  for (const chunk of chunks) {
    const size = new TextEncoder().encode(chunk).length;
    if (size < 1 || size > MAX_CHUNK_BYTES) throw new ConvexError({ code: "invalid_snapshot_chunk" });
    measured += size;
  }
  if (measured !== byteLength) throw new ConvexError({ code: "snapshot_size_mismatch" });
}

export async function insertSnapshot(
  ctx: MutationCtx,
  args: {
    projectId: Id<"projects">;
    revision: number;
    kind: "project" | "simulation";
    reason: string;
    sessionId: string;
    chunks: string[];
    byteLength: number;
  },
) {
  validateChunks(args.chunks, args.byteLength);
  const revisionId = await ctx.db.insert("projectRevisions", {
    projectId: args.projectId,
    revision: args.revision,
    kind: args.kind,
    reason: args.reason.slice(0, 80),
    createdAt: Date.now(),
    createdBy: args.sessionId,
    byteLength: args.byteLength,
    chunkCount: args.chunks.length,
  });
  for (let index = 0; index < args.chunks.length; index++) {
    await ctx.db.insert("revisionChunks", { revisionId, index, json: args.chunks[index] });
  }
  return revisionId;
}

export async function deleteSnapshot(ctx: MutationCtx, revisionId: Id<"projectRevisions">) {
  const chunks = await ctx.db
    .query("revisionChunks")
    .withIndex("by_revision_index", (q) => q.eq("revisionId", revisionId))
    .collect();
  for (const chunk of chunks) await ctx.db.delete(chunk._id);
  await ctx.db.delete(revisionId);
}
