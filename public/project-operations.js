(function installProjectOperations(root) {
  "use strict";

  const RECORD_COLLECTIONS = Object.freeze([
    "tools",
    "stats",
    "tagDefs",
    "zones",
    "directors",
    "entities",
    "factions",
  ]);
  const ROOT_FIELDS = Object.freeze([
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
  const MAX_ZONE_CHANGES = 1000;

  function clone(value) {
    if (typeof structuredClone === "function") return structuredClone(value);
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  }

  function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") {
      const result = {};
      for (const key of Object.keys(value).sort()) result[key] = canonical(value[key]);
      return result;
    }
    return value;
  }

  function stableStringify(value) {
    return JSON.stringify(canonical(value));
  }

  function same(left, right) {
    return stableStringify(left) === stableStringify(right);
  }

  function versionFor(versions, resourceKey) {
    const value = versions instanceof Map ? versions.get(resourceKey) : versions?.[resourceKey];
    return Number.isInteger(value) && value >= 0 ? value : 0;
  }

  function operation(kind, resourceKey, payload, versions) {
    return {
      kind,
      resourceKey,
      expectedVersion: versionFor(versions, resourceKey),
      payload: clone(payload),
    };
  }

  function recordsById(records) {
    const result = new Map();
    for (const record of Array.isArray(records) ? records : []) {
      if (record && typeof record === "object" && typeof record.id === "string" && record.id) {
        result.set(record.id, record);
      }
    }
    return result;
  }

  function zoneDefinition(zone) {
    const value = clone(zone);
    delete value.cells;
    return value;
  }

  function sortedCells(value) {
    return [...new Set((Array.isArray(value) ? value : []).filter(Number.isInteger))].sort((a, b) => a - b);
  }

  function zoneCellOperations(zoneId, beforeCells, afterCells, versions) {
    const before = new Set(sortedCells(beforeCells));
    const after = new Set(sortedCells(afterCells));
    const changes = [];
    for (const cell of after) if (!before.has(cell)) changes.push({ type: "add", cell });
    for (const cell of before) if (!after.has(cell)) changes.push({ type: "remove", cell });
    changes.sort((left, right) => left.cell - right.cell || left.type.localeCompare(right.type));
    const resourceKey = `zones:${zoneId}:cells`;
    const result = [];
    for (let index = 0; index < changes.length; index += MAX_ZONE_CHANGES) {
      const batch = changes.slice(index, index + MAX_ZONE_CHANGES);
      result.push(operation("paintZoneCells", resourceKey, {
        zoneId,
        add: batch.filter((item) => item.type === "add").map((item) => item.cell),
        remove: batch.filter((item) => item.type === "remove").map((item) => item.cell),
      }, versions));
    }
    return result;
  }

  function diffCollection(collection, beforeRecords, afterRecords, versions) {
    const before = recordsById(beforeRecords);
    const after = recordsById(afterRecords);
    const ids = [...new Set([...before.keys(), ...after.keys()])].sort();
    const result = [];
    for (const id of ids) {
      const previous = before.get(id);
      const next = after.get(id);
      const resourceKey = `${collection}:${id}`;
      if (!next) {
        result.push(operation("deleteRecord", resourceKey, { collection, id }, versions));
        continue;
      }
      if (!previous) {
        const value = collection === "zones" ? { ...zoneDefinition(next), cells: [] } : next;
        result.push(operation("setRecord", resourceKey, { collection, id, value }, versions));
        if (collection === "zones") result.push(...zoneCellOperations(id, [], next.cells, versions));
        continue;
      }
      const previousValue = collection === "zones" ? zoneDefinition(previous) : previous;
      const nextValue = collection === "zones" ? zoneDefinition(next) : next;
      if (!same(previousValue, nextValue)) {
        result.push(operation("setRecord", resourceKey, { collection, id, value: nextValue }, versions));
      }
      if (collection === "zones") {
        result.push(...zoneCellOperations(id, previous.cells, next.cells, versions));
      }
    }
    return result;
  }

  function diffWorld(before, after, versions = {}) {
    if (!before || !after || typeof before !== "object" || typeof after !== "object") {
      throw new TypeError("diffWorld requires two project objects.");
    }
    const result = [];
    for (const collection of RECORD_COLLECTIONS) {
      result.push(...diffCollection(collection, before[collection], after[collection], versions));
    }
    for (const field of ROOT_FIELDS) {
      if (field === "name" || same(before[field], after[field])) continue;
      const resourceKey = `root:${field}`;
      result.push(operation("setRoot", resourceKey, {
        field,
        value: clone(after[field]),
        delete: !Object.prototype.hasOwnProperty.call(after, field),
      }, versions));
    }
    if (!same(before.name, after.name)) {
      result.push(operation("renameProject", "root:name", { name: String(after.name ?? "").trim() }, versions));
    }
    return result;
  }

  function assertRecordPayload(payload) {
    if (!payload || typeof payload !== "object" || !RECORD_COLLECTIONS.includes(payload.collection)) {
      throw new TypeError("Invalid project record operation.");
    }
    if (typeof payload.id !== "string" || !payload.id) throw new TypeError("Invalid project record ID.");
  }

  function applyOperation(project, input, options = {}) {
    if (!project || typeof project !== "object") throw new TypeError("A project object is required.");
    if (!input || typeof input !== "object") throw new TypeError("A project operation is required.");
    const target = options.mutate ? project : clone(project);
    const payload = input.payload;
    if (input.kind === "setRecord") {
      assertRecordPayload(payload);
      if (!payload.value || typeof payload.value !== "object" || Array.isArray(payload.value)) {
        throw new TypeError("Invalid project record value.");
      }
      const records = Array.isArray(target[payload.collection]) ? target[payload.collection] : (target[payload.collection] = []);
      const index = records.findIndex((record) => record?.id === payload.id);
      let value = clone(payload.value);
      value.id = payload.id;
      if (payload.collection === "zones" && !Object.prototype.hasOwnProperty.call(value, "cells")) {
        value.cells = index >= 0 ? sortedCells(records[index].cells) : [];
      }
      if (index >= 0) records[index] = value;
      else records.push(value);
    } else if (input.kind === "deleteRecord") {
      assertRecordPayload(payload);
      const records = Array.isArray(target[payload.collection]) ? target[payload.collection] : [];
      target[payload.collection] = records.filter((record) => record?.id !== payload.id);
    } else if (input.kind === "paintZoneCells") {
      if (!payload || typeof payload.zoneId !== "string" || !Array.isArray(payload.add) || !Array.isArray(payload.remove)) {
        throw new TypeError("Invalid zone cell operation.");
      }
      const zone = (Array.isArray(target.zones) ? target.zones : []).find((item) => item?.id === payload.zoneId);
      if (!zone) throw new RangeError("The edited zone no longer exists.");
      const cells = new Set(sortedCells(zone.cells));
      for (const cell of payload.remove) if (Number.isInteger(cell)) cells.delete(cell);
      for (const cell of payload.add) if (Number.isInteger(cell)) cells.add(cell);
      zone.cells = [...cells].sort((a, b) => a - b);
    } else if (input.kind === "setRoot") {
      if (!payload || !ROOT_FIELDS.includes(payload.field) || payload.field === "name") {
        throw new TypeError("Invalid project root operation.");
      }
      if (payload.delete) delete target[payload.field];
      else target[payload.field] = clone(payload.value);
    } else if (input.kind === "renameProject") {
      const name = typeof payload?.name === "string" ? payload.name.trim() : "";
      if (!name) throw new TypeError("A project name is required.");
      target.name = name;
    } else {
      throw new TypeError(`Unsupported project operation: ${String(input.kind)}`);
    }
    return target;
  }

  function applyOperations(project, operations, options = {}) {
    let target = options.mutate ? project : clone(project);
    for (const input of operations ?? []) target = applyOperation(target, input, { mutate: true });
    return target;
  }

  function advanceVersions(versions, operations) {
    const result = versions instanceof Map ? new Map(versions) : new Map(Object.entries(versions ?? {}));
    for (const input of operations ?? []) {
      const current = Number(result.get(input.resourceKey) ?? input.expectedVersion ?? 0);
      result.set(input.resourceKey, Number.isInteger(input.resultingVersion) ? input.resultingVersion : current + 1);
    }
    return result;
  }

  root.PrototeerProjectOps = Object.freeze({
    RECORD_COLLECTIONS,
    ROOT_FIELDS,
    MAX_ZONE_CHANGES,
    stableStringify,
    diffWorld,
    applyOperation,
    applyOperations,
    advanceVersions,
  });
})(globalThis);
