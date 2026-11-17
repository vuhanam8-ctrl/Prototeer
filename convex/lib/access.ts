import { ConvexError } from "convex/values";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";

export type AccessRole = "owner" | "editor" | "viewer";
export type Access = { project: Doc<"projects">; capability: Doc<"projectCapabilities"> };

const textEncoder = new TextEncoder();

export async function digestToken(token: string): Promise<string> {
  if (
    typeof token !== "string" ||
    token.length < 43 ||
    token.length > 256 ||
    !/^[A-Za-z0-9_-]+$/.test(token)
  ) {
    throw new ConvexError({ code: "invalid_access_key" });
  }
  const bytes = await crypto.subtle.digest("SHA-256", textEncoder.encode(token));
  return Array.from(new Uint8Array(bytes), (value) => value.toString(16).padStart(2, "0")).join("");
}

export async function requireAccess(
  ctx: QueryCtx | MutationCtx,
  publicId: string,
  token: string,
): Promise<Access> {
  if (!/^[A-Za-z0-9_-]{16,80}$/.test(publicId)) {
    throw new ConvexError({ code: "project_not_found" });
  }
  const project = await ctx.db
    .query("projects")
    .withIndex("by_public_id", (q) => q.eq("publicId", publicId))
    .unique();
  if (!project) throw new ConvexError({ code: "project_not_found" });
  const tokenDigest = await digestToken(token);
  const capability = await ctx.db
    .query("projectCapabilities")
    .withIndex("by_token_digest", (q) => q.eq("tokenDigest", tokenDigest))
    .unique();
  if (!capability || capability.projectId !== project._id || capability.revokedAt !== undefined) {
    throw new ConvexError({ code: "access_denied" });
  }
  return { project, capability };
}

export function requireEditor(role: AccessRole) {
  if (role === "viewer") throw new ConvexError({ code: "editor_access_required" });
}

export function requireOwner(role: AccessRole) {
  if (role !== "owner") throw new ConvexError({ code: "owner_access_required" });
}

export function safeSessionId(value: string) {
  if (!/^[A-Za-z0-9_-]{12,100}$/.test(value)) throw new ConvexError({ code: "invalid_session" });
  return value;
}

export function safeOpId(value: string) {
  if (!/^[A-Za-z0-9_-]{12,120}$/.test(value)) throw new ConvexError({ code: "invalid_operation" });
  return value;
}
