(function installAnalytics(root) {
  "use strict";

  const EVENT_KINDS = Object.freeze([
    "panel_opened",
    "editor_opened",
    "editor_completed",
    "editor_cancelled",
    "editor_abandoned",
    "control_clicked",
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
  const PANELS = Object.freeze([
    "board",
    "object-types",
    "zones",
    "creatures",
    "stats",
    "interaction-rules",
    "tags",
    "behavior-tree",
    "directors",
    "history",
    "inspector",
    "dialog",
    "projects",
    "share",
    "header",
    "unknown",
  ]);
  const FLOWS = Object.freeze([
    "object-type",
    "creature",
    "stat",
    "interaction-rule",
    "tag",
    "zone",
    "behavior-node",
    "director",
    "project-import",
    "project-save",
    "project-share",
  ]);
  const RESULTS = Object.freeze(["success", "cancelled", "abandoned", "error", "conflict"]);
  const SURFACES = Object.freeze(["ui", "board"]);
  const HEATMAP_KINDS = Object.freeze(["click", "pointer", "scroll"]);
  const POINTER_TYPES = Object.freeze(["mouse", "pen", "touch", "unknown"]);
  const CONTEXT_ENUMS = Object.freeze({
    mode: ["select", "draw", "erase", "zone-add", "zone-remove"],
    nodeType: ["root", "sequence", "selector", "utility", "condition", "action", "rule"],
    connectionType: ["edge", "message"],
    settingType: ["number", "toggle", "select", "text", "color", "file"],
    objectKind: ["object", "creature", "zone", "stat", "rule", "tag", "director", "node"],
    errorCode: [
      "validation",
      "invalid_range",
      "invalid_reference",
      "save_failed",
      "storage_unavailable",
      "network",
      "permission",
      "conflict",
      "runtime",
    ],
    permission: ["owner", "editor", "viewer", "offline"],
    source: ["toolbar", "shortcut", "dialog", "board", "inspector", "graph", "project-menu"],
    pointerType: POINTER_TYPES,
  });
  const CONTEXT_NUMBERS = new Set(["cellCount", "changeCount", "attempt", "nodeCount", "edgeCount"]);
  const CONTEXT_BOOLEANS = new Set(["offline", "automatic", "keyboard"]);
  const MAX_EVENTS = 500;
  const MAX_BINS = 2000;
  const X_BINS = 32;
  const Y_BINS = 18;
  const EVENT_FIELDS = new Set([
    "schemaVersion", "eventId", "sessionId", "sequence", "occurredAt", "uiVersion",
    "kind", "surface", "panel", "controlId", "flow", "result", "durationMs",
    "viewportWidth", "viewportHeight", "dpr", "context",
  ]);
  const HEATMAP_FIELDS = new Set([
    "sessionId", "uiVersion", "surface", "panel", "kind", "xBin", "yBin",
    "viewportBucket", "pointerType", "count", "occurredAt",
  ]);

  function safeId(value, max = 100) {
    return typeof value === "string" && value.length > 0 && value.length <= max && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value);
  }

  function safeVersion(value) {
    return typeof value === "string" && value.length > 0 && value.length <= 40 && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
  }

  function finiteNumber(value, min, max) {
    return Number.isFinite(value) && value >= min && value <= max;
  }

  function viewport(value) {
    const width = Math.round(Number(value?.width));
    const height = Math.round(Number(value?.height));
    const dpr = Number(value?.dpr);
    if (!finiteNumber(width, 1, 20000) || !finiteNumber(height, 1, 20000) || !finiteNumber(dpr, 0.25, 10)) return null;
    return { width, height, dpr };
  }

  function sanitizeContext(value) {
    if (value === undefined) return undefined;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const output = {};
    for (const [key, item] of Object.entries(value)) {
      if (Object.prototype.hasOwnProperty.call(CONTEXT_ENUMS, key)) {
        if (!CONTEXT_ENUMS[key].includes(item)) return null;
        output[key] = item;
      } else if (CONTEXT_NUMBERS.has(key)) {
        if (!Number.isInteger(item) || item < 0 || item > 1000000) return null;
        output[key] = item;
      } else if (CONTEXT_BOOLEANS.has(key)) {
        if (typeof item !== "boolean") return null;
        output[key] = item;
      } else {
        return null;
      }
    }
    return output;
  }

  function sanitizeEvent(input, options = {}) {
    if (!input || typeof input !== "object" || !EVENT_KINDS.includes(input.kind)) return null;
    if (Object.keys(input).some((key) => !EVENT_FIELDS.has(key))) return null;
    if (!safeId(input.eventId) || !safeId(input.sessionId)) return null;
    if (!Number.isInteger(input.sequence) || input.sequence < 0 || input.sequence > 1000000000) return null;
    if (!finiteNumber(input.occurredAt, 0, 9007199254740991) || !safeVersion(input.uiVersion)) return null;
    if (!SURFACES.includes(input.surface) || !PANELS.includes(input.panel)) return null;
    const allowedControls = options.allowedControls instanceof Set
      ? options.allowedControls
      : new Set(options.allowedControls ?? []);
    if (input.controlId !== undefined && (!safeId(input.controlId, 80) || !allowedControls.has(input.controlId))) return null;
    if (input.flow !== undefined && !FLOWS.includes(input.flow)) return null;
    if (input.result !== undefined && !RESULTS.includes(input.result)) return null;
    if (input.durationMs !== undefined && !finiteNumber(input.durationMs, 0, 86400000)) return null;
    const size = viewport({ width: input.viewportWidth, height: input.viewportHeight, dpr: input.dpr });
    const context = sanitizeContext(input.context);
    if (!size || context === null) return null;
    return {
      schemaVersion: 1,
      eventId: input.eventId,
      sessionId: input.sessionId,
      sequence: input.sequence,
      occurredAt: input.occurredAt,
      uiVersion: input.uiVersion,
      kind: input.kind,
      surface: input.surface,
      panel: input.panel,
      ...(input.controlId === undefined ? {} : { controlId: input.controlId }),
      ...(input.flow === undefined ? {} : { flow: input.flow }),
      ...(input.result === undefined ? {} : { result: input.result }),
      ...(input.durationMs === undefined ? {} : { durationMs: Math.round(input.durationMs) }),
      viewportWidth: size.width,
      viewportHeight: size.height,
      dpr: size.dpr,
      ...(context === undefined ? {} : { context }),
    };
  }

  function viewportBucket(width) {
    if (width < 900) return "under-900";
    if (width < 1200) return "900-1199";
    if (width < 1600) return "1200-1599";
    return "1600-plus";
  }

  function sanitizeHeatmapBin(input) {
    if (!input || typeof input !== "object" || !safeId(input.sessionId) || !safeVersion(input.uiVersion)) return null;
    if (Object.keys(input).some((key) => !HEATMAP_FIELDS.has(key))) return null;
    if (!SURFACES.includes(input.surface) || !PANELS.includes(input.panel) || !HEATMAP_KINDS.includes(input.kind)) return null;
    if (!Number.isInteger(input.xBin) || input.xBin < 0 || input.xBin >= X_BINS) return null;
    if (!Number.isInteger(input.yBin) || input.yBin < 0 || input.yBin >= Y_BINS) return null;
    if (!["under-900", "900-1199", "1200-1599", "1600-plus"].includes(input.viewportBucket)) return null;
    if (input.pointerType !== undefined && !POINTER_TYPES.includes(input.pointerType)) return null;
    if (!Number.isInteger(input.count) || input.count < 1 || input.count > 1000000000) return null;
    if (!finiteNumber(input.occurredAt, 0, 9007199254740991)) return null;
    return {
      sessionId: input.sessionId,
      uiVersion: input.uiVersion,
      surface: input.surface,
      panel: input.panel,
      kind: input.kind,
      xBin: input.xBin,
      yBin: input.yBin,
      viewportBucket: input.viewportBucket,
      ...(input.pointerType === undefined ? {} : { pointerType: input.pointerType }),
      count: input.count,
      occurredAt: input.occurredAt,
    };
  }

  function randomId(prefix = "evt") {
    if (root.crypto?.randomUUID) return `${prefix}-${root.crypto.randomUUID()}`;
    if (root.crypto?.getRandomValues) {
      const bytes = new Uint8Array(16);
      root.crypto.getRandomValues(bytes);
      return `${prefix}-${[...bytes].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
    }
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
  }

  function defaultViewport() {
    return {
      width: Number(root.innerWidth) || 1,
      height: Number(root.innerHeight) || 1,
      dpr: Number(root.devicePixelRatio) || 1,
    };
  }

  function createAnalytics(options = {}) {
    const transport = options.transport ?? {};
    const sessionId = options.sessionId ?? randomId("session");
    const participantId = options.participantId ?? randomId("participant");
    const uiVersion = options.uiVersion ?? "dev";
    const consentVersion = Number.isInteger(options.consentVersion) ? options.consentVersion : 1;
    const allowedControls = new Set(options.allowedControls ?? []);
    const now = typeof options.now === "function" ? options.now : Date.now;
    const getViewport = typeof options.viewport === "function" ? options.viewport : defaultViewport;
    const intervalMs = Number(options.flushIntervalMs ?? 5000);
    const setIntervalFn = options.setIntervalFn ?? (root.document ? root.setInterval?.bind(root) : null);
    const clearIntervalFn = options.clearIntervalFn ?? root.clearInterval?.bind(root);
    let consent = options.consent === true;
    let sequence = 0;
    let started = false;
    let startPromise = null;
    let flushing = false;
    let destroyed = false;
    let activeFlow = null;
    let timer = null;
    const events = [];
    const bins = new Map();
    const lastSamples = new Map();

    function allowControl(value) {
      if (!safeId(value, 80)) return false;
      allowedControls.add(value);
      return true;
    }

    function syncTimer() {
      if (consent && !destroyed && !timer && setIntervalFn && intervalMs > 0) {
        timer = setIntervalFn(() => { void flush(); }, intervalMs);
        if (timer && typeof timer.unref === "function") timer.unref();
      } else if ((!consent || destroyed) && timer && clearIntervalFn) {
        clearIntervalFn(timer);
        timer = null;
      }
    }

    function safeCall(name, value) {
      if (typeof transport[name] !== "function") return Promise.resolve(true);
      try {
        return Promise.resolve(transport[name](value)).then(() => true, () => false);
      } catch {
        return Promise.resolve(false);
      }
    }

    function startSession() {
      if (started) return Promise.resolve(true);
      if (startPromise) return startPromise;
      if (!consent || destroyed || !safeId(sessionId) || !safeId(participantId) || !safeVersion(uiVersion)) return Promise.resolve(false);
      const size = viewport(getViewport());
      if (!size) return Promise.resolve(false);
      startPromise = safeCall("startSession", {
        schemaVersion: 1,
        sessionId,
        participantId,
        consentVersion,
        uiVersion,
        viewportWidth: size.width,
        viewportHeight: size.height,
        dpr: size.dpr,
        startedAt: now(),
      }).then((ok) => {
        started = ok;
        return ok;
      }).finally(() => {
        startPromise = null;
      });
      return startPromise;
    }

    function record(kind, details = {}) {
      if (!consent || destroyed) return false;
      void startSession();
      const size = viewport(getViewport());
      if (!size) return false;
      const candidate = sanitizeEvent({
        schemaVersion: 1,
        eventId: randomId("event"),
        sessionId,
        sequence: sequence + 1,
        occurredAt: now(),
        uiVersion,
        kind,
        surface: details.surface ?? "ui",
        panel: details.panel ?? "unknown",
        controlId: details.controlId,
        flow: details.flow,
        result: details.result,
        durationMs: details.durationMs,
        viewportWidth: size.width,
        viewportHeight: size.height,
        dpr: size.dpr,
        context: details.context,
      }, { allowedControls });
      if (!candidate) return false;
      sequence++;
      events.push(candidate);
      if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
      return true;
    }

    function sampleHeatmap(kind, details = {}) {
      if (!consent || destroyed || !HEATMAP_KINDS.includes(kind)) return false;
      void startSession();
      const surface = details.surface ?? "ui";
      const panel = details.panel ?? "unknown";
      if (!SURFACES.includes(surface) || !PANELS.includes(panel)) return false;
      const size = viewport(getViewport());
      if (!size) return false;
      const timestamp = now();
      const throttle = kind === "pointer" ? 100 : kind === "scroll" ? 250 : 0;
      const throttleKey = `${kind}|${surface}|${panel}`;
      if (throttle && timestamp - (lastSamples.get(throttleKey) ?? -Infinity) < throttle) return false;
      lastSamples.set(throttleKey, timestamp);
      const regionWidth = Number(details.width ?? size.width);
      const regionHeight = Number(details.height ?? size.height);
      if (!finiteNumber(regionWidth, 1, 20000) || !finiteNumber(regionHeight, 1, 20000)) return false;
      let x = Number(details.x);
      let y = Number(details.y);
      if (kind === "scroll" && finiteNumber(details.scrollDepth, 0, 1)) {
        x = 0.5 * regionWidth;
        y = Number(details.scrollDepth) * regionHeight;
      }
      if (!finiteNumber(x, 0, regionWidth) || !finiteNumber(y, 0, regionHeight)) return false;
      const xBin = Math.min(X_BINS - 1, Math.floor((x / regionWidth) * X_BINS));
      const yBin = Math.min(Y_BINS - 1, Math.floor((y / regionHeight) * Y_BINS));
      const pointerType = POINTER_TYPES.includes(details.pointerType) ? details.pointerType : "unknown";
      const bucket = viewportBucket(size.width);
      const key = [sessionId, uiVersion, surface, panel, kind, xBin, yBin, bucket, pointerType].join("|");
      const existing = bins.get(key);
      const value = sanitizeHeatmapBin({
        sessionId,
        uiVersion,
        surface,
        panel,
        kind,
        xBin,
        yBin,
        viewportBucket: bucket,
        pointerType,
        count: (existing?.count ?? 0) + 1,
        occurredAt: timestamp,
      });
      if (!value) return false;
      bins.set(key, value);
      if (bins.size > MAX_BINS) bins.delete(bins.keys().next().value);
      return true;
    }

    async function flush() {
      if (!consent || destroyed || flushing) return false;
      flushing = true;
      const eventBatch = events.splice(0, events.length);
      const binBatch = [...bins.values()];
      bins.clear();
      try {
        if (!await startSession()) {
          events.unshift(...eventBatch.slice(-MAX_EVENTS));
          for (const item of binBatch.slice(-MAX_BINS)) {
            const key = [item.sessionId, item.uiVersion, item.surface, item.panel, item.kind, item.xBin, item.yBin, item.viewportBucket, item.pointerType].join("|");
            bins.set(key, item);
          }
          return false;
        }
        if (eventBatch.length && typeof transport.batch === "function") {
          try {
            await transport.batch(eventBatch);
          } catch {
            events.unshift(...eventBatch.slice(-MAX_EVENTS));
          }
        }
        if (binBatch.length && typeof transport.batchHeatmap === "function") {
          try {
            await transport.batchHeatmap(binBatch);
          } catch {
            for (const item of binBatch.slice(-MAX_BINS)) {
              const key = [item.sessionId, item.uiVersion, item.surface, item.panel, item.kind, item.xBin, item.yBin, item.viewportBucket, item.pointerType].join("|");
              const existing = bins.get(key);
              bins.set(key, { ...item, count: item.count + (existing?.count ?? 0) });
            }
          }
        }
        return true;
      } finally {
        flushing = false;
      }
    }

    function beginFlow(flow, details = {}) {
      if (!FLOWS.includes(flow) || !consent) return false;
      if (activeFlow) abandonFlow();
      activeFlow = { flow, startedAt: now(), panel: details.panel ?? "dialog" };
      return record("editor_opened", { flow, panel: activeFlow.panel });
    }

    function finishFlow(kind, result) {
      if (!activeFlow) return false;
      const flow = activeFlow;
      activeFlow = null;
      return record(kind, {
        flow: flow.flow,
        panel: flow.panel,
        result,
        durationMs: Math.max(0, now() - flow.startedAt),
      });
    }

    function completeFlow() {
      return finishFlow("editor_completed", "success");
    }

    function cancelFlow() {
      return finishFlow("editor_cancelled", "cancelled");
    }

    function abandonFlow() {
      return finishFlow("editor_abandoned", "abandoned");
    }

    function setConsent(value) {
      consent = value === true;
      syncTimer();
      if (consent) void startSession();
      else {
        events.length = 0;
        bins.clear();
        activeFlow = null;
      }
    }

    async function destroy() {
      if (destroyed) return;
      if (activeFlow) abandonFlow();
      await flush();
      destroyed = true;
      if (started) await safeCall("endSession", { sessionId, endedAt: now() });
    }

    syncTimer();

    return Object.freeze({
      record,
      allowControl,
      sampleHeatmap,
      beginFlow,
      completeFlow,
      cancelFlow,
      abandonFlow,
      flush,
      setConsent,
      hasConsent: () => consent,
      pendingCounts: () => ({ events: events.length, bins: bins.size }),
      session: () => ({ sessionId, participantId, uiVersion, consentVersion }),
      destroy: async () => {
        if (timer && clearIntervalFn) clearIntervalFn(timer);
        timer = null;
        await destroy();
      },
    });
  }

  root.PrototeerAnalytics = Object.freeze({
    EVENT_KINDS,
    PANELS,
    FLOWS,
    SURFACES,
    HEATMAP_KINDS,
    POINTER_TYPES,
    X_BINS,
    Y_BINS,
    sanitizeEvent,
    sanitizeHeatmapBin,
    createAnalytics,
  });
})(globalThis);
