import { internalMutation, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { ConvexError, v } from "convex/values";
import { requireAccess, requireEditor, requireOwner, safeSessionId } from "./lib/access";

const MAX_ASSETS_PER_PROJECT = 200;
const MAX_ASSET_BYTES = 8 * 1024 * 1024;
const MAX_PROJECT_ASSET_BYTES = 64 * 1024 * 1024;
const MAX_UPLOAD_GRANTS_PER_WINDOW = 20;
const UPLOAD_GRANT_WINDOW_MS = 10 * 60 * 1000;
const UPLOAD_GRANT_LIFETIME_MS = 10 * 60 * 1000;
const ALLOWED_CONTENT_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/avif",
]);

function safeAssetPublicId(value: string) {
  if (!/^[A-Za-z0-9_-]{16,100}$/.test(value)) {
    throw new ConvexError({ code: "invalid_asset_id" });
  }
  return value;
}

function safeOriginalName(value: string | undefined) {
  if (!value) return undefined;
  const name = value.replace(/[\u0000-\u001f\u007f\\/]/g, "").trim().slice(0, 120);
  return name || undefined;
}

export const createUploadUrl = mutation({
  args: {
    publicId: v.string(),
    token: v.string(),
    sessionId: v.string(),
  },
  handler: async (ctx, args) => {
    safeSessionId(args.sessionId);
    const { project, capability } = await requireAccess(ctx, args.publicId, args.token);
    requireEditor(capability.role);
    if (project.simulationStatus !== "paused") {
      throw new ConvexError({ code: "pause_before_editing" });
    }

    const assets = await ctx.db
      .query("assets")
      .withIndex("by_project_created", (q) => q.eq("projectId", project._id))
      .take(MAX_ASSETS_PER_PROJECT + 1);
    if (assets.length >= MAX_ASSETS_PER_PROJECT) {
      throw new ConvexError({ code: "asset_limit_reached" });
    }

    const now = Date.now();
    const recentGrants = await ctx.db
      .query("assetUploadGrants")
      .withIndex("by_project_created", (q) =>
        q.eq("projectId", project._id).gt("createdAt", now - UPLOAD_GRANT_WINDOW_MS),
      )
      .take(MAX_UPLOAD_GRANTS_PER_WINDOW + 1);
    if (recentGrants.length >= MAX_UPLOAD_GRANTS_PER_WINDOW) {
      throw new ConvexError({ code: "upload_rate_limited" });
    }

    const expiresAt = now + UPLOAD_GRANT_LIFETIME_MS;
    const grantId = await ctx.db.insert("assetUploadGrants", {
      projectId: project._id,
      sessionId: args.sessionId,
      createdAt: now,
      expiresAt,
    });
    const uploadUrl = await ctx.storage.generateUploadUrl();
    return { grantId, uploadUrl, expiresAt };
  },
});

export const finalizeUpload = mutation({
  args: {
    publicId: v.string(),
    token: v.string(),
    sessionId: v.string(),
    grantId: v.id("assetUploadGrants"),
    assetPublicId: v.string(),
    storageId: v.id("_storage"),
    originalName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    safeSessionId(args.sessionId);
    safeAssetPublicId(args.assetPublicId);
    const { project, capability } = await requireAccess(ctx, args.publicId, args.token);
    requireEditor(capability.role);
    if (project.simulationStatus !== "paused") {
      throw new ConvexError({ code: "pause_before_editing" });
    }

    const grant = await ctx.db.get(args.grantId);
    if (
      !grant ||
      grant.projectId !== project._id ||
      grant.sessionId !== args.sessionId ||
      grant.usedAt !== undefined ||
      grant.expiresAt < Date.now()
    ) {
      throw new ConvexError({ code: "invalid_upload_grant" });
    }

    const [existingPublicId, existingStorage, metadata] = await Promise.all([
      ctx.db
        .query("assets")
        .withIndex("by_project_public_id", (q) =>
          q.eq("projectId", project._id).eq("publicId", args.assetPublicId),
        )
        .unique(),
      ctx.db
        .query("assets")
        .withIndex("by_storage_id", (q) => q.eq("storageId", args.storageId))
        .unique(),
      ctx.db.system.get("_storage", args.storageId),
    ]);
    if (existingPublicId || existingStorage) {
      throw new ConvexError({ code: "asset_id_unavailable" });
    }
    if (!metadata) throw new ConvexError({ code: "uploaded_file_not_found" });
    const contentType = metadata.contentType ?? "";
    if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
      throw new ConvexError({ code: "unsupported_artwork_type" });
    }
    if (!Number.isInteger(metadata.size) || metadata.size < 1 || metadata.size > MAX_ASSET_BYTES) {
      throw new ConvexError({ code: "artwork_too_large" });
    }

    const projectAssets = await ctx.db
      .query("assets")
      .withIndex("by_project_created", (q) => q.eq("projectId", project._id))
      .take(MAX_ASSETS_PER_PROJECT + 1);
    if (projectAssets.length >= MAX_ASSETS_PER_PROJECT) {
      throw new ConvexError({ code: "asset_limit_reached" });
    }
    const totalBytes = projectAssets.reduce((total, asset) => total + asset.byteLength, 0);
    if (totalBytes + metadata.size > MAX_PROJECT_ASSET_BYTES) {
      throw new ConvexError({ code: "project_artwork_limit_reached" });
    }

    const now = Date.now();
    const assetId = await ctx.db.insert("assets", {
      projectId: project._id,
      publicId: args.assetPublicId,
      storageId: args.storageId,
      contentType,
      byteLength: metadata.size,
      sha256: metadata.sha256,
      originalName: safeOriginalName(args.originalName),
      createdBy: args.sessionId,
      createdAt: now,
    });
    await ctx.db.patch(grant._id, { usedAt: now });
    return {
      assetId,
      publicId: args.assetPublicId,
      contentType,
      byteLength: metadata.size,
      sha256: metadata.sha256,
    };
  },
});

export const list = query({
  args: { publicId: v.string(), token: v.string() },
  handler: async (ctx, args) => {
    const { project } = await requireAccess(ctx, args.publicId, args.token);
    const assets = await ctx.db
      .query("assets")
      .withIndex("by_project_created", (q) => q.eq("projectId", project._id))
      .collect();
    return Promise.all(
      assets.map(async (asset) => ({
        publicId: asset.publicId,
        contentType: asset.contentType,
        byteLength: asset.byteLength,
        sha256: asset.sha256,
        originalName: asset.originalName,
        createdAt: asset.createdAt,
        url: await ctx.storage.getUrl(asset.storageId),
      })),
    );
  },
});

export const get = query({
  args: { publicId: v.string(), token: v.string(), assetPublicId: v.string() },
  handler: async (ctx, args) => {
    safeAssetPublicId(args.assetPublicId);
    const { project } = await requireAccess(ctx, args.publicId, args.token);
    const asset = await ctx.db
      .query("assets")
      .withIndex("by_project_public_id", (q) =>
        q.eq("projectId", project._id).eq("publicId", args.assetPublicId),
      )
      .unique();
    if (!asset) throw new ConvexError({ code: "asset_not_found" });
    return {
      publicId: asset.publicId,
      contentType: asset.contentType,
      byteLength: asset.byteLength,
      sha256: asset.sha256,
      originalName: asset.originalName,
      createdAt: asset.createdAt,
      url: await ctx.storage.getUrl(asset.storageId),
    };
  },
});

export const remove = mutation({
  args: { publicId: v.string(), token: v.string(), assetPublicId: v.string() },
  handler: async (ctx, args) => {
    safeAssetPublicId(args.assetPublicId);
    const { project, capability } = await requireAccess(ctx, args.publicId, args.token);
    requireOwner(capability.role);
    if (project.simulationStatus !== "paused") {
      throw new ConvexError({ code: "pause_before_editing" });
    }
    const asset = await ctx.db
      .query("assets")
      .withIndex("by_project_public_id", (q) =>
        q.eq("projectId", project._id).eq("publicId", args.assetPublicId),
      )
      .unique();
    if (!asset) return { removed: false };
    await ctx.storage.delete(asset.storageId);
    await ctx.db.delete(asset._id);
    return { removed: true };
  },
});

export const cleanupUploadGrants = internalMutation({
  args: {},
  handler: async (ctx): Promise<number> => {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const grants = await ctx.db
      .query("assetUploadGrants")
      .withIndex("by_expiry", (q) => q.lt("expiresAt", cutoff))
      .take(500);
    for (const grant of grants) await ctx.db.delete(grant._id);
    if (grants.length === 500) {
      await ctx.scheduler.runAfter(100, internal.assets.cleanupUploadGrants, {});
    }
    return grants.length;
  },
});
