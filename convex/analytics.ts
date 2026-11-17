import { internalMutation, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import { requireAccess, requireOwner, safeSessionId } from "./lib/access";

const MAX_EVENTS_PER_BATCH = 50;
const MAX_HEATMAP_BINS_PER_BATCH = 200;
const MAX_BATCH_BYTES = 250_000;
const MAX_EVENTS_PER_SESSION = 5_000;
const MAX_HEATMAP_SAMPLES_PER_SESSION = 100_000;
const MAX_SESSIONS_PER_HOUR = 20;
const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

const EVENT_KINDS = new Set([
  "panel_opened",
  "editor_opened",
  "editor_completed",
  "editor_cancelled",
  "editor_abandoned",
  "control_changed",
  "board_mode_changed",
  "board_stroke",
  "node_created",
  "node_connected",
  "node_disconnected",
  "node_moved",
  "simulation_run",
  "simulation_pause",
  "simulation_step",
  "simulation_reset",
  "save_started",
  "save_succeeded",
  "save_failed",
  "project_imported",
  "project_exported",
  "project_opened",
  "validation_error",
  "undo",
  "redo",
]);

const PANELS = new Set([
  "analytics",
  "behavior-tree",
  "board",
  "creatures",
  "dialog",
  "directors",
  "header",
  "history",
  "inspector",
  "interaction-rules",
  "object-types",
  "projects",
  "share",
  "stats",
  "tags",
  "unknown",
  "zones",
]);

const RESULTS = new Set([
  "abandoned",
  "cancelled",
  "conflict",
  "error",
  "success",
]);

const FLOWS = new Set([
  "behavior-node",
  "creature",
  "director",
  "interaction-rule",
  "object-type",
  "project-import",
  "project-save",
  "project-share",
  "stat",
  "tag",
  "zone",
]);

const CONTEXT_ENUMS: Record<string, ReadonlySet<string>> = {
  connectionType: new Set(["edge", "message"]),
  errorCode: new Set([
    "conflict",
    "invalid_reference",
    "invalid_range",
    "network",
    "permission",
    "runtime",
    "save_failed",
    "storage_unavailable",
    "validation",
  ]),
  mode: new Set(["draw", "erase", "select", "zone-add", "zone-remove"]),
  nodeType: new Set([
    "action",
    "condition",
    "root",
    "rule",
    "selector",
    "sequence",
    "utility",
  ]),
  objectKind: new Set([
    "creature",
    "director",
    "node",
    "object",
    "rule",
    "stat",
    "tag",
    "zone",
  ]),
  permission: new Set(["editor", "offline", "owner", "viewer"]),
  pointerType: new Set(["mouse", "pen", "touch", "unknown"]),
  settingType: new Set(["color", "file", "number", "select", "text", "toggle"]),
  source: new Set([
    "board",
    "dialog",
    "graph",
    "inspector",
    "project-menu",
    "shortcut",
    "toolbar",
  ]),
};
const CONTEXT_NUMBERS = new Set(["attempt", "cellCount", "changeCount", "edgeCount", "nodeCount"]);
const CONTEXT_BOOLEANS = new Set(["automatic", "keyboard", "offline"]);
const VIEWPORT_BUCKETS = new Set(["under-900", "900-1199", "1200-1599", "1600-plus"]);
const POINTER_TYPES = new Set(["mouse", "pen", "touch", "unknown"]);

const eventValidator = v.object({
  schemaVersion: v.number(),
  eventId: v.string(),
  projectId: v.string(),
  sessionId: v.string(),
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
});

const heatmapValidator = v.object({
  sessionId: v.string(),
  uiVersion: v.string(),
  surface: v.union(v.literal("ui"), v.literal("board")),
  panel: v.string(),
  kind: v.union(v.literal("click"), v.literal("pointer"), v.literal("scroll")),
  xBin: v.number(),
  yBin: v.number(),
  viewportBucket: v.string(),
  pointerType: v.optional(v.string()),
  count: v.number(),
  occurredAt: v.number(),
});

function integer(value: number, min: number, max: number) {
  return Number.isInteger(value) && value >= min && value <= max;
}

function safeParticipantId(value: string) {
  if (!/^[A-Za-z0-9_-]{12,100}$/.test(value)) {
    throw new ConvexError({ code: "invalid_analytics_participant" });
  }
  return value;
}

function safeBatchId(value: string) {
  if (!/^[A-Za-z0-9_-]{12,120}$/.test(value)) {
    throw new ConvexError({ code: "invalid_analytics_batch" });
  }
  return value;
}

function safeUiVersion(value: string) {
  if (!/^[A-Za-z0-9._-]{1,40}$/.test(value)) {
    throw new ConvexError({ code: "invalid_ui_version" });
  }
  return value;
}

function safePanel(value: string) {
  if (!PANELS.has(value)) throw new ConvexError({ code: "invalid_analytics_panel" });
  return value;
}

function safeViewport(width: number, height: number, dpr: number) {
  if (!integer(width, 1, 20_000) || !integer(height, 1, 20_000)) {
    throw new ConvexError({ code: "invalid_analytics_viewport" });
  }
  if (!Number.isFinite(dpr) || dpr < 0.25 || dpr > 10) {
    throw new ConvexError({ code: "invalid_analytics_viewport" });
  }
}

function safeTimestamp(value: number, now: number) {
  if (!integer(value, 0, 9_000_000_000_000) || value < now - 24 * 60 * 60 * 1000 || value > now + 5 * 60 * 1000) {
    throw new ConvexError({ code: "invalid_analytics_time" });
  }
  return value;
}

function safeOptionalToken(value: string | undefined, field: string, max = 80) {
  if (value === undefined) return undefined;
  if (value.length > max || !/^[A-Za-z][A-Za-z0-9._:-]*$/.test(value)) {
    throw new ConvexError({ code: `invalid_analytics_${field}` });
  }
  return value;
}

function sanitizeContext(value: unknown) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ConvexError({ code: "invalid_analytics_context" });
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 8) throw new ConvexError({ code: "invalid_analytics_context" });
  const result: Record<string, boolean | number | string> = {};
  for (const [key, item] of entries) {
    if (typeof item === "boolean") {
      if (!CONTEXT_BOOLEANS.has(key)) {
        throw new ConvexError({ code: "invalid_analytics_context" });
      }
      result[key] = item;
    } else if (typeof item === "number") {
      if (
        !CONTEXT_NUMBERS.has(key) ||
        !Number.isInteger(item) ||
        item < 0 ||
        item > 1_000_000
      ) {
        throw new ConvexError({ code: "invalid_analytics_context" });
      }
      result[key] = item;
    } else if (typeof item === "string" && CONTEXT_ENUMS[key]?.has(item)) {
      result[key] = item;
    } else {
      throw new ConvexError({ code: "invalid_analytics_context" });
    }
  }
  return result;
}

function sanitizeEvent(
  event: typeof eventValidator.type,
  now: number,
  publicId: string,
  sessionId: string,
) {
  if (event.schemaVersion !== 1 || event.projectId !== publicId || event.sessionId !== sessionId) {
    throw new ConvexError({ code: "invalid_analytics_event" });
  }
  if (!/^[A-Za-z0-9_-]{12,120}$/.test(event.eventId)) {
    throw new ConvexError({ code: "invalid_analytics_event" });
  }
  if (!integer(event.sequence, 1, 1_000_000_000) || !EVENT_KINDS.has(event.kind)) {
    throw new ConvexError({ code: "invalid_analytics_event" });
  }
  safeUiVersion(event.uiVersion);
  safePanel(event.panel);
  safeViewport(event.viewportWidth, event.viewportHeight, event.dpr);
  safeTimestamp(event.occurredAt, now);
  const controlId = safeOptionalToken(event.controlId, "control", 100);
  const flow = safeOptionalToken(event.flow, "flow", 60);
  if (flow !== undefined && !FLOWS.has(flow)) {
    throw new ConvexError({ code: "invalid_analytics_flow" });
  }
  if (event.result !== undefined && !RESULTS.has(event.result)) {
    throw new ConvexError({ code: "invalid_analytics_result" });
  }
  if (
    event.durationMs !== undefined &&
    (!integer(event.durationMs, 0, 24 * 60 * 60 * 1000))
  ) {
    throw new ConvexError({ code: "invalid_analytics_duration" });
  }
  const { projectId: _projectId, sessionId: _sessionId, ...storedEvent } = event;
  return {
    ...storedEvent,
    controlId,
    flow,
    context: sanitizeContext(event.context),
  };
}

function sanitizeHeatmap(bin: typeof heatmapValidator.type, now: number, sessionId: string) {
  if (bin.sessionId !== sessionId) throw new ConvexError({ code: "invalid_heatmap_session" });
  safeUiVersion(bin.uiVersion);
  safePanel(bin.panel);
  safeTimestamp(bin.occurredAt, now);
  if (!integer(bin.xBin, 0, 31) || !integer(bin.yBin, 0, 17) || !integer(bin.count, 1, 100_000)) {
    throw new ConvexError({ code: "invalid_heatmap_bin" });
  }
  const viewportBucket = bin.viewportBucket;
  if (!VIEWPORT_BUCKETS.has(viewportBucket)) {
    throw new ConvexError({ code: "invalid_viewport_bucket" });
  }
  const pointerType = bin.pointerType ?? "unknown";
  if (!POINTER_TYPES.has(pointerType)) {
    throw new ConvexError({ code: "invalid_pointer_type" });
  }
  const binKey = [
    bin.uiVersion,
    bin.surface,
    bin.panel,
    bin.kind,
    bin.xBin,
    bin.yBin,
    viewportBucket,
    pointerType,
  ].join(":");
  const { sessionId: _sessionId, ...storedBin } = bin;
  return { ...storedBin, viewportBucket, pointerType, binKey };
}

function checkPagination(numItems: number) {
  if (!integer(numItems, 1, 500)) throw new ConvexError({ code: "invalid_export_page_size" });
}

export const startSession = mutation({
  args: {
    publicId: v.string(),
    token: v.string(),
    sessionId: v.string(),
    participantId: v.string(),
    consentVersion: v.number(),
    uiVersion: v.string(),
    viewportWidth: v.number(),
    viewportHeight: v.number(),
    dpr: v.number(),
  },
  handler: async (ctx, args) => {
    safeSessionId(args.sessionId);
    safeParticipantId(args.participantId);
    safeUiVersion(args.uiVersion);
    safeViewport(args.viewportWidth, args.viewportHeight, args.dpr);
    if (!integer(args.consentVersion, 1, 100)) {
      throw new ConvexError({ code: "analytics_consent_required" });
    }
    const { project } = await requireAccess(ctx, args.publicId, args.token);
    const existing = await ctx.db
      .query("analyticsSessions")
      .withIndex("by_project_session", (q) =>
        q.eq("projectId", project._id).eq("sessionId", args.sessionId),
      )
      .unique();
    if (existing) {
      if (existing.participantId !== args.participantId) {
        throw new ConvexError({ code: "analytics_session_conflict" });
      }
      await ctx.db.patch(existing._id, {
        consentVersion: args.consentVersion,
        uiVersion: args.uiVersion,
        viewportWidth: args.viewportWidth,
        viewportHeight: args.viewportHeight,
        dpr: args.dpr,
        endedAt: undefined,
        lastSeenAt: Date.now(),
      });
      return { startedAt: existing.startedAt, resumed: true };
    }

    const now = Date.now();
    const recentSessions = await ctx.db
      .query("analyticsSessions")
      .withIndex("by_project_started", (q) =>
        q.eq("projectId", project._id).gt("startedAt", now - 60 * 60 * 1000),
      )
      .take(MAX_SESSIONS_PER_HOUR + 1);
    if (recentSessions.length >= MAX_SESSIONS_PER_HOUR) {
      throw new ConvexError({ code: "analytics_rate_limited" });
    }
    await ctx.db.insert("analyticsSessions", {
      projectId: project._id,
      sessionId: args.sessionId,
      participantId: args.participantId,
      consentVersion: args.consentVersion,
      uiVersion: args.uiVersion,
      viewportWidth: args.viewportWidth,
      viewportHeight: args.viewportHeight,
      dpr: args.dpr,
      startedAt: now,
      lastSeenAt: now,
      lastSequence: 0,
      eventCount: 0,
      heatmapCount: 0,
    });
    return { startedAt: now, resumed: false };
  },
});

export const endSession = mutation({
  args: { publicId: v.string(), token: v.string(), sessionId: v.string() },
  handler: async (ctx, args) => {
    safeSessionId(args.sessionId);
    const { project } = await requireAccess(ctx, args.publicId, args.token);
    const session = await ctx.db
      .query("analyticsSessions")
      .withIndex("by_project_session", (q) =>
        q.eq("projectId", project._id).eq("sessionId", args.sessionId),
      )
      .unique();
    if (!session) return { ended: false };
    const now = Date.now();
    await ctx.db.patch(session._id, { endedAt: now, lastSeenAt: now });
    return { ended: true };
  },
});

export const ingestEvents = mutation({
  args: {
    publicId: v.string(),
    token: v.string(),
    sessionId: v.string(),
    events: v.array(eventValidator),
  },
  handler: async (ctx, args) => {
    safeSessionId(args.sessionId);
    if (args.events.length < 1 || args.events.length > MAX_EVENTS_PER_BATCH) {
      throw new ConvexError({ code: "invalid_analytics_batch" });
    }
    if (new TextEncoder().encode(JSON.stringify(args.events)).length > MAX_BATCH_BYTES) {
      throw new ConvexError({ code: "analytics_batch_too_large" });
    }
    const { project } = await requireAccess(ctx, args.publicId, args.token);
    const session = await ctx.db
      .query("analyticsSessions")
      .withIndex("by_project_session", (q) =>
        q.eq("projectId", project._id).eq("sessionId", args.sessionId),
      )
      .unique();
    if (!session || session.endedAt !== undefined) {
      throw new ConvexError({ code: "analytics_session_not_active" });
    }
    const now = Date.now();
    const events = args.events
      .map((event) => sanitizeEvent(event, now, args.publicId, args.sessionId))
      .sort((a, b) => a.sequence - b.sequence);
    let lastSequence = session.lastSequence;
    let accepted = 0;
    let duplicates = 0;
    for (const event of events) {
      const duplicate = await ctx.db
        .query("analyticsEvents")
        .withIndex("by_project_event", (q) =>
          q.eq("projectId", project._id).eq("eventId", event.eventId),
        )
        .unique();
      if (duplicate) {
        if (duplicate.sessionId !== args.sessionId || duplicate.sequence !== event.sequence) {
          throw new ConvexError({ code: "analytics_event_conflict" });
        }
        duplicates++;
        continue;
      }
      if (event.sequence <= lastSequence) {
        throw new ConvexError({ code: "stale_analytics_sequence" });
      }
      if (session.eventCount + accepted + 1 > MAX_EVENTS_PER_SESSION) {
        throw new ConvexError({ code: "analytics_session_limit_reached" });
      }
      await ctx.db.insert("analyticsEvents", {
        projectId: project._id,
        sessionId: args.sessionId,
        ...event,
      });
      lastSequence = event.sequence;
      accepted++;
    }
    await ctx.db.patch(session._id, {
      lastSeenAt: now,
      lastSequence,
      eventCount: session.eventCount + accepted,
    });
    return { accepted, duplicates, lastSequence };
  },
});

export const ingestHeatmap = mutation({
  args: {
    publicId: v.string(),
    token: v.string(),
    sessionId: v.string(),
    batchId: v.string(),
    bins: v.array(heatmapValidator),
  },
  handler: async (ctx, args) => {
    safeSessionId(args.sessionId);
    safeBatchId(args.batchId);
    if (args.bins.length < 1 || args.bins.length > MAX_HEATMAP_BINS_PER_BATCH) {
      throw new ConvexError({ code: "invalid_heatmap_batch" });
    }
    if (new TextEncoder().encode(JSON.stringify(args.bins)).length > MAX_BATCH_BYTES) {
      throw new ConvexError({ code: "analytics_batch_too_large" });
    }
    const { project } = await requireAccess(ctx, args.publicId, args.token);
    const session = await ctx.db
      .query("analyticsSessions")
      .withIndex("by_project_session", (q) =>
        q.eq("projectId", project._id).eq("sessionId", args.sessionId),
      )
      .unique();
    if (!session || session.endedAt !== undefined) {
      throw new ConvexError({ code: "analytics_session_not_active" });
    }
    const duplicateBatch = await ctx.db
      .query("analyticsBatches")
      .withIndex("by_project_session_batch", (q) =>
        q.eq("projectId", project._id).eq("sessionId", args.sessionId).eq("batchId", args.batchId),
      )
      .unique();
    if (duplicateBatch) return { accepted: 0, samples: 0, duplicate: true };
    const now = Date.now();
    const bins = args.bins.map((bin) => sanitizeHeatmap(bin, now, args.sessionId));
    const sampleCount = bins.reduce((total, bin) => total + bin.count, 0);
    if (session.heatmapCount + sampleCount > MAX_HEATMAP_SAMPLES_PER_SESSION) {
      throw new ConvexError({ code: "analytics_session_limit_reached" });
    }
    for (const bin of bins) {
      const existing = await ctx.db
        .query("analyticsHeatmapBins")
        .withIndex("by_project_session_bin", (q) =>
          q.eq("projectId", project._id).eq("sessionId", args.sessionId).eq("binKey", bin.binKey),
        )
        .unique();
      if (existing) {
        await ctx.db.patch(existing._id, {
          count: Math.min(1_000_000_000, existing.count + bin.count),
          occurredAt: Math.max(existing.occurredAt, bin.occurredAt),
        });
      } else {
        await ctx.db.insert("analyticsHeatmapBins", {
          projectId: project._id,
          sessionId: args.sessionId,
          ...bin,
        });
      }
    }
    await ctx.db.patch(session._id, {
      lastSeenAt: now,
      heatmapCount: session.heatmapCount + sampleCount,
    });
    await ctx.db.insert("analyticsBatches", {
      projectId: project._id,
      sessionId: args.sessionId,
      batchId: args.batchId,
      kind: "heatmap",
      createdAt: now,
    });
    return { accepted: bins.length, samples: sampleCount, duplicate: false };
  },
});

export const exportSessions = query({
  args: {
    publicId: v.string(),
    token: v.string(),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    checkPagination(args.paginationOpts.numItems);
    const { project, capability } = await requireAccess(ctx, args.publicId, args.token);
    requireOwner(capability.role);
    const result = await ctx.db
      .query("analyticsSessions")
      .withIndex("by_project_started", (q) => q.eq("projectId", project._id))
      .order("asc")
      .paginate(args.paginationOpts);
    return {
      ...result,
      page: result.page.map((session) => ({
        sessionId: session.sessionId,
        participantId: session.participantId,
        consentVersion: session.consentVersion,
        uiVersion: session.uiVersion,
        viewportWidth: session.viewportWidth,
        viewportHeight: session.viewportHeight,
        dpr: session.dpr,
        startedAt: session.startedAt,
        endedAt: session.endedAt,
        eventCount: session.eventCount,
        heatmapCount: session.heatmapCount,
      })),
    };
  },
});

export const exportEvents = query({
  args: {
    publicId: v.string(),
    token: v.string(),
    paginationOpts: paginationOptsValidator,
    from: v.optional(v.number()),
    to: v.optional(v.number()),
    kind: v.optional(v.string()),
    panel: v.optional(v.string()),
    surface: v.optional(v.union(v.literal("ui"), v.literal("board"))),
  },
  handler: async (ctx, args) => {
    checkPagination(args.paginationOpts.numItems);
    const { project, capability } = await requireAccess(ctx, args.publicId, args.token);
    requireOwner(capability.role);
    if (args.kind !== undefined && !EVENT_KINDS.has(args.kind)) {
      throw new ConvexError({ code: "invalid_analytics_filter" });
    }
    if (args.panel !== undefined) safePanel(args.panel);
    const result = await ctx.db
      .query("analyticsEvents")
      .withIndex("by_project_time", (q) => q.eq("projectId", project._id))
      .filter((q) =>
        q.and(
          args.from === undefined ? q.eq(q.field("projectId"), project._id) : q.gte(q.field("occurredAt"), args.from),
          args.to === undefined ? q.eq(q.field("projectId"), project._id) : q.lte(q.field("occurredAt"), args.to),
          args.kind === undefined ? q.eq(q.field("projectId"), project._id) : q.eq(q.field("kind"), args.kind),
          args.panel === undefined ? q.eq(q.field("projectId"), project._id) : q.eq(q.field("panel"), args.panel),
          args.surface === undefined ? q.eq(q.field("projectId"), project._id) : q.eq(q.field("surface"), args.surface),
        ),
      )
      .order("asc")
      .paginate(args.paginationOpts);
    return {
      ...result,
      page: result.page.map((event) => ({
        schemaVersion: event.schemaVersion,
        projectId: args.publicId,
        sessionId: event.sessionId,
        eventId: event.eventId,
        sequence: event.sequence,
        occurredAt: event.occurredAt,
        uiVersion: event.uiVersion,
        kind: event.kind,
        surface: event.surface,
        panel: event.panel,
        controlId: event.controlId,
        flow: event.flow,
        result: event.result,
        durationMs: event.durationMs,
        viewportWidth: event.viewportWidth,
        viewportHeight: event.viewportHeight,
        dpr: event.dpr,
        context: event.context,
      })),
    };
  },
});

export const exportHeatmap = query({
  args: {
    publicId: v.string(),
    token: v.string(),
    paginationOpts: paginationOptsValidator,
    from: v.optional(v.number()),
    to: v.optional(v.number()),
    panel: v.optional(v.string()),
    surface: v.optional(v.union(v.literal("ui"), v.literal("board"))),
  },
  handler: async (ctx, args) => {
    checkPagination(args.paginationOpts.numItems);
    const { project, capability } = await requireAccess(ctx, args.publicId, args.token);
    requireOwner(capability.role);
    if (args.panel !== undefined) safePanel(args.panel);
    const result = await ctx.db
      .query("analyticsHeatmapBins")
      .withIndex("by_project_time", (q) => q.eq("projectId", project._id))
      .filter((q) =>
        q.and(
          args.from === undefined ? q.eq(q.field("projectId"), project._id) : q.gte(q.field("occurredAt"), args.from),
          args.to === undefined ? q.eq(q.field("projectId"), project._id) : q.lte(q.field("occurredAt"), args.to),
          args.panel === undefined ? q.eq(q.field("projectId"), project._id) : q.eq(q.field("panel"), args.panel),
          args.surface === undefined ? q.eq(q.field("projectId"), project._id) : q.eq(q.field("surface"), args.surface),
        ),
      )
      .order("asc")
      .paginate(args.paginationOpts);
    return {
      ...result,
      page: result.page.map((bin) => ({
        sessionId: bin.sessionId,
        uiVersion: bin.uiVersion,
        surface: bin.surface,
        panel: bin.panel,
        kind: bin.kind,
        xBin: bin.xBin,
        yBin: bin.yBin,
        viewportBucket: bin.viewportBucket,
        pointerType: bin.pointerType,
        count: bin.count,
        occurredAt: bin.occurredAt,
      })),
    };
  },
});

export const clear = mutation({
  args: { publicId: v.string(), token: v.string() },
  handler: async (ctx, args) => {
    const { project, capability } = await requireAccess(ctx, args.publicId, args.token);
    requireOwner(capability.role);
    const [events, heatmap, sessions, batches] = await Promise.all([
      ctx.db
        .query("analyticsEvents")
        .withIndex("by_project_time", (q) => q.eq("projectId", project._id))
        .take(500),
      ctx.db
        .query("analyticsHeatmapBins")
        .withIndex("by_project_time", (q) => q.eq("projectId", project._id))
        .take(500),
      ctx.db
        .query("analyticsSessions")
        .withIndex("by_project_started", (q) => q.eq("projectId", project._id))
        .take(500),
      ctx.db
        .query("analyticsBatches")
        .withIndex("by_project_session_batch", (q) => q.eq("projectId", project._id))
        .take(500),
    ]);
    for (const row of events) await ctx.db.delete(row._id);
    for (const row of heatmap) await ctx.db.delete(row._id);
    for (const row of sessions) await ctx.db.delete(row._id);
    for (const row of batches) await ctx.db.delete(row._id);
    return {
      deleted: events.length + heatmap.length + sessions.length + batches.length,
      more:
        events.length === 500 ||
        heatmap.length === 500 ||
        sessions.length === 500 ||
        batches.length === 500,
    };
  },
});

export const cleanupOld = internalMutation({
  args: {},
  handler: async (ctx): Promise<number> => {
    const cutoff = Date.now() - RETENTION_MS;
    const [events, heatmap, sessions, batches] = await Promise.all([
      ctx.db
        .query("analyticsEvents")
        .withIndex("by_time", (q) => q.lt("occurredAt", cutoff))
        .take(500),
      ctx.db
        .query("analyticsHeatmapBins")
        .withIndex("by_time", (q) => q.lt("occurredAt", cutoff))
        .take(500),
      ctx.db
        .query("analyticsSessions")
        .withIndex("by_last_seen", (q) => q.lt("lastSeenAt", cutoff))
        .take(500),
      ctx.db
        .query("analyticsBatches")
        .withIndex("by_time", (q) => q.lt("createdAt", cutoff))
        .take(500),
    ]);
    for (const row of events) await ctx.db.delete(row._id);
    for (const row of heatmap) await ctx.db.delete(row._id);
    for (const row of sessions) await ctx.db.delete(row._id);
    for (const row of batches) await ctx.db.delete(row._id);
    if (
      events.length === 500 ||
      heatmap.length === 500 ||
      sessions.length === 500 ||
      batches.length === 500
    ) {
      await ctx.scheduler.runAfter(100, internal.analytics.cleanupOld, {});
    }
    return events.length + heatmap.length + sessions.length + batches.length;
  },
});
