(function installPrototeerCollaboration(global) {
  'use strict';

  const REGISTRY_KEY = 'prototeer.shared-projects.v1';
  const IDENTITY_KEY = 'prototeer.guest-identity.v1';
  const CONFIG_KEY = 'prototeer.convex-url.v1';
  const CHUNK_BYTES = 650000;
  const MAX_PROJECT_BYTES = 12 * 1024 * 1024;
  const encoder = new TextEncoder();

  const clone = value => structuredClone(value);
  const nowIso = () => new Date().toISOString();
  const randomKey = (bytes = 32) => {
    const data = crypto.getRandomValues(new Uint8Array(bytes));
    return Array.from(data, value => value.toString(16).padStart(2, '0')).join('');
  };
  const safeJson = (storage, key, fallback) => {
    try {
      const value = JSON.parse(storage?.getItem(key) || 'null');
      return value ?? fallback;
    } catch {
      return fallback;
    }
  };
  const writeJson = (storage, key, value) => {
    try {
      storage?.setItem(key, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  };
  const initials = name => String(name || 'Guest').trim().split(/\s+/).slice(0, 2).map(part => part[0]).join('').toUpperCase() || 'G';
  const errorCode = error => {
    const data = error?.data;
    if (typeof data === 'string') return data.slice(0, 80);
    if (data && typeof data.code === 'string') return data.code.slice(0, 80);
    return 'backend_unavailable';
  };
  const isDesktop = () => {
    if (typeof global.matchMedia !== 'function') return true;
    return global.matchMedia('(min-width: 1051px) and (pointer: fine)').matches;
  };
  const hashAccess = () => {
    const hash = global.location?.hash?.replace(/^#/, '') || '';
    if (!hash || typeof global.URLSearchParams !== 'function') return null;
    const params = new global.URLSearchParams(hash);
    const projectId = params.get('project') || '';
    const token = params.get('access') || '';
    const backend = params.get('backend') || '';
    return /^[A-Za-z0-9_-]{16,80}$/.test(projectId) && token.length >= 32 ? { projectId, token, backend } : null;
  };
  const accessUrl = (projectId, token, backend = '') => {
    const url = new URL(global.location.href);
    const params = { project: projectId, access: token };
    if (/^https:\/\/[a-z0-9-]+\.convex\.cloud$/i.test(backend)) params.backend = backend;
    url.hash = new global.URLSearchParams(params).toString();
    return url.href;
  };
  const splitUtf8 = value => {
    const json = typeof value === 'string' ? value : JSON.stringify(value);
    const byteLength = encoder.encode(json).length;
    if (byteLength > MAX_PROJECT_BYTES) throw new Error('project_too_large');
    const chunks = [];
    let start = 0;
    while (start < json.length) {
      let low = start + 1;
      let high = Math.min(json.length, start + CHUNK_BYTES);
      let best = low;
      while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        const length = encoder.encode(json.slice(start, middle)).length;
        if (length <= CHUNK_BYTES) {
          best = middle;
          low = middle + 1;
        } else high = middle - 1;
      }
      if (best < json.length && best > start && /[\uD800-\uDBFF]/.test(json[best - 1]) && /[\uDC00-\uDFFF]/.test(json[best])) best--;
      chunks.push(json.slice(start, best));
      start = best;
    }
    return { chunks, byteLength };
  };

  function operationApi() {
    const source = global.PrototeerProjectOps || {};
    return {
      diff(before, after, versions) {
        if (typeof source.diffWorld === 'function') return source.diffWorld(before, after, versions);
        if (typeof source.diffProject === 'function') return source.diffProject(before, after, versions);
        throw new Error('project_operations_unavailable');
      },
      apply(world, operation) {
        if (typeof source.applyOperation === 'function') return source.applyOperation(world, operation);
        if (typeof source.applyProjectOperation === 'function') return source.applyProjectOperation(world, operation);
        throw new Error('project_operations_unavailable');
      },
    };
  }

  function identity(storage) {
    const stored = safeJson(storage, IDENTITY_KEY, null);
    if (stored && /^[A-Za-z0-9_-]{12,100}$/.test(stored.sessionId) && typeof stored.name === 'string') return stored;
    const number = 100 + Math.floor(Math.random() * 900);
    const colors = ['#b8c5d6', '#d4bfc8', '#bdd1c2', '#d5c6ad', '#c3bfda', '#b6ccd2'];
    const value = { sessionId: randomKey(18), name: `Guest ${number}`, color: colors[number % colors.length] };
    writeJson(storage, IDENTITY_KEY, value);
    return value;
  }

  function create(options = {}) {
    const hooks = options.hooks || {};
    const storage = options.storage || global.localStorage;
    const metaUrl = global.document?.querySelector?.('meta[name="prototeer-convex-url"]')?.content?.trim();
    let deploymentUrl = options.url || metaUrl || safeJson(storage, CONFIG_KEY, '') || '';
    const apiRoot = global.convex?.anyApi;
    let client = deploymentUrl && global.convex?.ConvexClient ? new global.convex.ConvexClient(deploymentUrl) : null;
    const guest = identity(storage);
    const ops = operationApi();
    const seen = new Set();
    const artworkByData = new Map();
    const artworkById = new Map();
    let registry = safeJson(storage, REGISTRY_KEY, {});
    let active = null;
    let role = 'viewer';
    let revision = 0;
    let snapshotRevision = 0;
    let versions = {};
    let shadow = null;
    let pendingWorld = null;
    let flushTimer = 0;
    let flushing = null;
    let tailStop = null;
    let presenceStop = null;
    let simulationStop = null;
    let presenceTimer = 0;
    let presenceState = { view: 'board' };
    let presenceSentAt = 0;
    let tailGeneration = 0;
    let simulationStatus = 'paused';
    let simulationGeneration = 0;
    let controller = false;
    let frameInFlight = false;
    let lastFrameAt = 0;
    let closed = false;

    const emitStatus = (state, detail = '') => hooks.onStatus?.({ state, detail, active: Boolean(active), role });
    const remember = value => {
      registry[value.projectId] = { ...(registry[value.projectId] || {}), ...value, updatedAt: nowIso() };
      writeJson(storage, REGISTRY_KEY, registry);
    };
    const credentials = () => active ? { publicId: active.projectId, token: active.token } : null;
    const requireClient = () => {
      if (!isDesktop()) throw new Error('desktop_required');
      if (!client || !apiRoot) throw new Error('online_backend_not_configured');
      return client;
    };
    const changeHash = (projectId, token) => {
      const url = accessUrl(projectId, token, deploymentUrl);
      global.history?.replaceState?.(null, '', url);
      global.document?.body?.classList.add('collaboration-linked');
    };
    const clearSubscriptions = () => {
      tailStop?.();
      presenceStop?.();
      simulationStop?.();
      tailStop = presenceStop = simulationStop = null;
      clearInterval(presenceTimer);
      presenceTimer = 0;
      tailGeneration++;
    };

    async function blobDataUrl(blob) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('artwork_download_failed'));
        reader.readAsDataURL(blob);
      });
    }

    async function uploadArtwork(dataUrl) {
      if (artworkByData.has(dataUrl)) return artworkByData.get(dataUrl);
      const blob = await fetch(dataUrl).then(response => response.blob());
      const grant = await client.mutation(apiRoot.assets.createUploadUrl, { ...credentials(), sessionId: guest.sessionId });
      const upload = await fetch(grant.uploadUrl, { method: 'POST', headers: { 'Content-Type': blob.type }, body: blob });
      if (!upload.ok) throw new Error('artwork_upload_failed');
      const { storageId } = await upload.json();
      const assetPublicId = randomKey(18);
      await client.mutation(apiRoot.assets.finalizeUpload, {
        ...credentials(),
        sessionId: guest.sessionId,
        grantId: grant.grantId,
        assetPublicId,
        storageId,
      });
      artworkByData.set(dataUrl, assetPublicId);
      artworkById.set(assetPublicId, dataUrl);
      return assetPublicId;
    }

    async function outgoingOperation(operation) {
      if (operation.kind !== 'setRecord' || operation.payload?.collection !== 'tools') return operation;
      const image = operation.payload.value?.image;
      if (typeof image !== 'string' || !/^data:image\/(?:png|jpeg);base64,/.test(image)) return operation;
      const assetPublicId = await uploadArtwork(image);
      const wire = clone(operation);
      wire.payload.value.image = null;
      wire.payload.value.imageAsset = assetPublicId;
      return wire;
    }

    async function preserveArtwork(project) {
      let uploaded = 0;
      for (const tool of project?.tools || []) {
        if (uploaded >= 20) break;
        if (typeof tool.image !== 'string' || !/^data:image\/(?:png|jpeg);base64,/.test(tool.image) || artworkByData.has(tool.image)) continue;
        try {
          await uploadArtwork(tool.image);
          uploaded++;
        } catch {
          break;
        }
      }
      return uploaded;
    }

    async function materializeOperation(operation) {
      const assetPublicId = operation.payload?.value?.imageAsset;
      if (operation.kind !== 'setRecord' || operation.payload?.collection !== 'tools' || !assetPublicId) return operation;
      const value = clone(operation);
      let dataUrl = artworkById.get(assetPublicId);
      if (!dataUrl) {
        const asset = await client.query(apiRoot.assets.get, { ...credentials(), assetPublicId });
        const response = await fetch(asset.url);
        if (!response.ok) throw new Error('artwork_download_failed');
        dataUrl = await blobDataUrl(await response.blob());
        artworkById.set(assetPublicId, dataUrl);
        artworkByData.set(dataUrl, assetPublicId);
      }
      value.payload.value.image = dataUrl;
      delete value.payload.value.imageAsset;
      return value;
    }

    async function applyIncoming(operation, notify = true) {
      if (!shadow || seen.has(operation.opId)) return;
      seen.add(operation.opId);
      if (seen.size > 4000) seen.delete(seen.values().next().value);
      const materialized = await materializeOperation(operation);
      shadow = ops.apply(shadow, materialized) || shadow;
      versions[operation.resourceKey] = operation.resultingVersion ?? versions[operation.resourceKey] ?? 0;
      revision = Math.max(revision, operation.sequence || 0);
      if (notify && operation.sessionId !== guest.sessionId) hooks.onRemoteOperation?.(clone(materialized), clone(shadow));
      return operation.sessionId !== guest.sessionId ? materialized : null;
    }

    async function processTail(result) {
      if (!active || !result) return;
      if (result.needsBootstrap) {
        await bootstrap(active.projectId, active.token, { preserveUi: true });
        return;
      }
      role = result.role || role;
      simulationStatus = result.simulationStatus || simulationStatus;
      const previous = revision;
      const list = [...(result.operations || [])].sort((a, b) => a.sequence - b.sequence);
      const remote = [];
      for (const operation of list) if (operation.sequence > revision) {
        const materialized = await applyIncoming(operation, false);
        if (materialized) remote.push(materialized);
      }
      if (remote.length) {
        if (hooks.onRemoteOperations) hooks.onRemoteOperations(clone(remote), clone(shadow));
        else for (const operation of remote) hooks.onRemoteOperation?.(clone(operation), clone(shadow));
      }
      snapshotRevision = Math.max(snapshotRevision, result.snapshotRevision || 0);
      if (result.revision > revision && revision === previous) {
        await bootstrap(active.projectId, active.token, { preserveUi: true });
        return;
      }
      if (result.truncated || revision < result.revision || revision > previous) subscribeTail();
    }

    function subscribeTail() {
      if (!active || !client) return;
      tailStop?.();
      const generation = ++tailGeneration;
      const after = revision;
      tailStop = client.onUpdate(
        apiRoot.collaboration.tail,
        { ...credentials(), after },
        result => {
          if (generation !== tailGeneration) return;
          void processTail(result).catch(error => emitStatus('offline', errorCode(error)));
        },
        error => emitStatus('offline', errorCode(error)),
      );
    }

    async function sendPresence(force = false) {
      if (!active || !client || closed) return;
      const stamp = Date.now();
      if (!force && stamp - presenceSentAt < 90) return;
      presenceSentAt = stamp;
      try {
        await client.mutation(apiRoot.collaboration.updatePresence, {
          ...credentials(),
          sessionId: guest.sessionId,
          displayName: guest.name,
          color: guest.color,
          view: presenceState.view || 'board',
          editingKind: presenceState.editingKind || undefined,
          editingId: presenceState.editingId || undefined,
          pointerX: Number.isFinite(presenceState.pointerX) ? presenceState.pointerX : undefined,
          pointerY: Number.isFinite(presenceState.pointerY) ? presenceState.pointerY : undefined,
        });
      } catch (error) {
        emitStatus('offline', errorCode(error));
      }
    }

    function subscribePresence() {
      if (!active || !client) return;
      presenceStop?.();
      presenceStop = client.onUpdate(
        apiRoot.collaboration.listPresence,
        credentials(),
        entries => hooks.onPresence?.((entries || []).map(entry => ({ ...entry, initials: initials(entry.displayName), self: entry.sessionId === guest.sessionId }))),
        error => emitStatus('offline', errorCode(error)),
      );
      clearInterval(presenceTimer);
      presenceTimer = setInterval(() => void sendPresence(true), 15000);
      void sendPresence(true);
    }

    function subscribeSimulation() {
      if (!active || !client) return;
      simulationStop?.();
      simulationStop = client.onUpdate(
        apiRoot.simulation.state,
        credentials(),
        result => {
          if (!result) return;
          const wasRunning = simulationStatus === 'running';
          simulationStatus = result.status;
          simulationGeneration = result.generation;
          controller = result.status === 'running' && result.controllerSessionId === guest.sessionId;
          if (result.status === 'running' && !controller && result.chunks?.length) {
            try {
              hooks.onRuntimeFrame?.(JSON.parse(result.chunks.join('')), { tick: result.tick, generation: result.generation });
            } catch {
              emitStatus('conflict', 'invalid_simulation_frame');
            }
          }
          hooks.onSimulation?.({ status: result.status, controller, tick: result.tick, generation: result.generation, changed: wasRunning !== (result.status === 'running') });
        },
        error => emitStatus('offline', errorCode(error)),
      );
    }

    function bindSubscriptions() {
      subscribeTail();
      subscribePresence();
      subscribeSimulation();
    }

    async function bootstrap(projectId, token, config = {}) {
      requireClient();
      emitStatus('syncing');
      const data = await client.query(apiRoot.projects.open, { publicId: projectId, token });
      active = { projectId, token };
      let project = JSON.parse(data.chunks.join(''));
      let replayRevision = data.project.snapshotRevision;
      const replay = async operation => {
        const materialized = await materializeOperation(operation);
        project = ops.apply(project, materialized) || project;
        seen.add(operation.opId);
        replayRevision = Math.max(replayRevision, operation.sequence || 0);
      };
      for (const operation of [...(data.operations || [])].sort((a, b) => a.sequence - b.sequence)) await replay(operation);
      let pageCount = 0;
      while (replayRevision < data.project.revision) {
        if (++pageCount > 200) throw new Error('checkpoint_required');
        const page = await client.query(apiRoot.collaboration.tail, { publicId: projectId, token, after: replayRevision });
        if (page.needsBootstrap || !page.operations?.length) throw new Error('checkpoint_required');
        for (const operation of [...page.operations].sort((a, b) => a.sequence - b.sequence)) await replay(operation);
      }
      role = data.role;
      revision = replayRevision;
      snapshotRevision = data.project.snapshotRevision;
      versions = { ...(data.versions || {}) };
      shadow = clone(project);
      pendingWorld = null;
      simulationStatus = data.project.simulationStatus;
      remember({ projectId, token, role, name: data.project.name });
      changeHash(projectId, token);
      clearSubscriptions();
      bindSubscriptions();
      hooks.onBootstrap?.(clone(project), { role, revision, preserveUi: Boolean(config.preserveUi), projectId });
      emitStatus('synced');
      return clone(project);
    }

    async function createOnline(world) {
      requireClient();
      const publicId = randomKey(24);
      const ownerToken = randomKey();
      const editorToken = randomKey();
      const viewerToken = randomKey();
      const snapshot = splitUtf8(world);
      emitStatus('syncing');
      await client.mutation(apiRoot.projects.create, {
        publicId,
        ownerToken,
        editorToken,
        viewerToken,
        sessionId: guest.sessionId,
        name: String(world.name || 'Untitled sandbox').slice(0, 100),
        formatVersion: Number(world.version || 1),
        ...snapshot,
      });
      active = { projectId: publicId, token: ownerToken };
      role = 'owner';
      revision = snapshotRevision = 0;
      versions = {};
      shadow = clone(world);
      remember({ projectId: publicId, token: ownerToken, role, name: world.name, editorToken, viewerToken, createdAt: nowIso() });
      changeHash(publicId, ownerToken);
      clearSubscriptions();
      bindSubscriptions();
      await preserveArtwork(world);
      emitStatus('synced');
      return shareInfo();
    }

    async function flush() {
      clearTimeout(flushTimer);
      flushTimer = 0;
      if (!active || !pendingWorld || role === 'viewer') return;
      if (flushing) return flushing;
      let targetInFlight = null;
      flushing = (async () => {
        if (simulationStatus === 'running') await pauseSimulation();
        while (pendingWorld) {
          const target = pendingWorld;
          targetInFlight = target;
          pendingWorld = null;
          const changes = ops.diff(shadow, target, versions);
          if (!changes.length) continue;
          emitStatus('syncing');
          for (const change of changes) {
            const operation = { ...change, opId: change.opId || randomKey(18), sessionId: guest.sessionId };
            const wireOperation = await outgoingOperation(operation);
            const result = await client.mutation(apiRoot.collaboration.submitOperation, {
              ...credentials(),
              sessionId: guest.sessionId,
              opId: operation.opId,
              kind: wireOperation.kind,
              resourceKey: wireOperation.resourceKey,
              expectedVersion: operation.expectedVersion ?? versions[operation.resourceKey] ?? 0,
              payload: wireOperation.payload,
            });
            if (result.status === 'conflict') {
              emitStatus('conflict', 'edit_conflict');
              hooks.onConflict?.({ resourceKey: operation.resourceKey });
              await bootstrap(active.projectId, active.token, { preserveUi: true });
              return;
            }
            seen.add(operation.opId);
            operation.sequence = result.revision;
            operation.resultingVersion = result.version;
            shadow = ops.apply(shadow, operation) || shadow;
            versions[operation.resourceKey] = result.version;
            revision = Math.max(revision, result.revision);
          }
          targetInFlight = null;
        }
        emitStatus('synced');
      })().catch(error => {
        if (!pendingWorld && targetInFlight) pendingWorld = targetInFlight;
        emitStatus('offline', errorCode(error));
        hooks.onError?.(errorCode(error));
      }).finally(() => {
        flushing = null;
        if (pendingWorld) flushTimer = setTimeout(() => void flush(), 2000);
      });
      return flushing;
    }

    function projectChanged(world) {
      if (!active || role === 'viewer') return false;
      pendingWorld = clone(world);
      clearTimeout(flushTimer);
      flushTimer = setTimeout(() => void flush(), 90);
      return true;
    }

    async function checkpoint(world) {
      requireClient();
      if (role === 'viewer') throw new Error('editor_access_required');
      if (world) pendingWorld = clone(world);
      await flush();
      const snapshot = splitUtf8(shadow);
      emitStatus('syncing');
      const result = await client.mutation(apiRoot.projects.checkpoint, {
        ...credentials(),
        sessionId: guest.sessionId,
        expectedRevision: revision,
        reason: 'Saved',
        ...snapshot,
      });
      if (result.status === 'conflict') {
        await bootstrap(active.projectId, active.token, { preserveUi: true });
        throw new Error('save_conflict');
      }
      snapshotRevision = result.revision;
      emitStatus('synced');
      return result;
    }

    async function startSimulation() {
      requireClient();
      if (role === 'viewer') throw new Error('editor_access_required');
      await flush();
      const result = await client.mutation(apiRoot.simulation.start, {
        ...credentials(),
        sessionId: guest.sessionId,
        expectedProjectRevision: revision,
      });
      if (result.status === 'conflict') {
        await bootstrap(active.projectId, active.token, { preserveUi: true });
        throw new Error('simulation_conflict');
      }
      simulationStatus = 'running';
      simulationGeneration = result.generation;
      controller = result.status === 'started';
      hooks.onSimulation?.({ status: 'running', controller, tick: 0, generation: simulationGeneration, changed: true });
      return { ...result, controller };
    }

    async function pauseSimulation() {
      if (!active || role === 'viewer') return false;
      await client.mutation(apiRoot.simulation.pause, { ...credentials(), sessionId: guest.sessionId });
      simulationStatus = 'paused';
      controller = false;
      hooks.onSimulation?.({ status: 'paused', controller: false, changed: true });
      return true;
    }

    async function resetSimulation() {
      requireClient();
      if (role === 'viewer') throw new Error('editor_access_required');
      await client.mutation(apiRoot.simulation.reset, { ...credentials(), sessionId: guest.sessionId });
      simulationStatus = 'paused';
      controller = false;
      hooks.onSimulation?.({ status: 'paused', controller: false, tick: 0, changed: true, reset: true });
    }

    async function publishSimulation(world, force = false) {
      if (!active || !controller || simulationStatus !== 'running' || frameInFlight) return false;
      if (!force && Date.now() - lastFrameAt < 650) return false;
      frameInFlight = true;
      lastFrameAt = Date.now();
      try {
        const snapshot = splitUtf8(world);
        await client.mutation(apiRoot.simulation.publishFrame, {
          ...credentials(),
          sessionId: guest.sessionId,
          generation: simulationGeneration,
          tick: Number(world.tick || 0),
          ...snapshot,
        });
        return true;
      } catch (error) {
        controller = false;
        emitStatus('offline', errorCode(error));
        hooks.onSimulation?.({ status: 'paused', controller: false, changed: true });
        return false;
      } finally {
        frameInFlight = false;
      }
    }

    async function createAccess(roleName, label) {
      requireClient();
      if (role !== 'owner') throw new Error('owner_access_required');
      if (!['editor', 'viewer'].includes(roleName)) throw new Error('invalid_role');
      const newToken = randomKey();
      await client.mutation(apiRoot.projects.createCapability, {
        ...credentials(),
        newToken,
        role: roleName,
        label: String(label || `${roleName} link`).slice(0, 60),
      });
      const record = registry[active.projectId] || { projectId: active.projectId };
      record[`${roleName}Token`] = newToken;
      remember(record);
      return accessUrl(active.projectId, newToken, deploymentUrl);
    }

    async function listCapabilities() {
      requireClient();
      if (role !== 'owner') throw new Error('owner_access_required');
      return client.query(apiRoot.projects.listCapabilities, credentials());
    }

    async function revokeCapability(capabilityId, roleName) {
      requireClient();
      if (role !== 'owner') throw new Error('owner_access_required');
      const result = await client.mutation(apiRoot.projects.revokeCapability, { ...credentials(), capabilityId });
      const record = registry[active.projectId];
      if (record && ['editor', 'viewer'].includes(roleName)) {
        delete record[`${roleName}Token`];
        remember(record);
      }
      return result;
    }

    async function listRevisions() {
      requireClient();
      return client.query(apiRoot.projects.listRevisions, credentials());
    }

    async function restoreRevision(revisionId) {
      requireClient();
      if (role !== 'owner') throw new Error('owner_access_required');
      await client.mutation(apiRoot.projects.restoreRevision, { ...credentials(), sessionId: guest.sessionId, revisionId });
      return bootstrap(active.projectId, active.token, { preserveUi: true });
    }

    function analyticsTransport() {
      if (!client) return null;
      return {
        startSession(session) {
          return client.mutation(apiRoot.analytics.startSession, {
            sessionId: session.sessionId,
            participantId: session.participantId,
            consentVersion: session.consentVersion,
            uiVersion: session.uiVersion,
            viewportWidth: session.viewportWidth,
            viewportHeight: session.viewportHeight,
            dpr: session.dpr,
          });
        },
        async batch(events) {
          if (!events?.length) return Promise.resolve();
          for (let index = 0; index < events.length; index += 50) {
            const chunk = events.slice(index, index + 50);
            await client.mutation(apiRoot.analytics.ingestEvents, { sessionId: chunk[0].sessionId, events: chunk });
          }
        },
        async batchHeatmap(bins) {
          if (!bins?.length) return Promise.resolve();
          for (let index = 0; index < bins.length; index += 200) {
            const chunk = bins.slice(index, index + 200);
            await client.mutation(apiRoot.analytics.ingestHeatmap, { sessionId: chunk[0].sessionId, batchId: randomKey(18), bins: chunk });
          }
        },
        endSession(info) {
          return client.mutation(apiRoot.analytics.endSession, { sessionId: info.sessionId });
        },
      };
    }

    function shareInfo() {
      if (!active) return { active: false, available: Boolean(client), desktop: isDesktop() };
      const record = registry[active.projectId] || {};
      return {
        active: true,
        available: Boolean(client),
        desktop: isDesktop(),
        projectId: active.projectId,
        role,
        ownerUrl: role === 'owner' ? accessUrl(active.projectId, active.token, deploymentUrl) : undefined,
        editorUrl: record.editorToken ? accessUrl(active.projectId, record.editorToken, deploymentUrl) : undefined,
        viewerUrl: record.viewerToken ? accessUrl(active.projectId, record.viewerToken, deploymentUrl) : undefined,
      };
    }

    function recoveryData() {
      if (!active || role !== 'owner') throw new Error('owner_access_required');
      const record = registry[active.projectId] || {};
      return {
        type: 'prototeer-recovery',
        version: 1,
        projectId: active.projectId,
        ownerAccess: active.token,
        url: accessUrl(active.projectId, active.token, deploymentUrl),
        projectName: shadow?.name || record.name || 'Prototeer project',
        createdAt: record.createdAt || nowIso(),
      };
    }

    async function configure(url) {
      const value = String(url || '').trim().replace(/\/$/, '');
      if (value && !/^https:\/\/[a-z0-9-]+\.convex\.cloud$/i.test(value)) throw new Error('invalid_convex_url');
      deploymentUrl = value;
      writeJson(storage, CONFIG_KEY, value);
      client?.close?.();
      client = value && global.convex?.ConvexClient ? new global.convex.ConvexClient(value) : null;
      return Boolean(client);
    }

    async function joinFromLocation() {
      const access = hashAccess();
      if (!access) return null;
      global.document?.body?.classList.add('collaboration-linked');
      if (!isDesktop()) return { desktopRequired: true };
      if (!client && access.backend) await configure(access.backend);
      return bootstrap(access.projectId, access.token);
    }

    function setPresence(next) {
      presenceState = { ...presenceState, ...next };
      void sendPresence(false);
    }

    function listKnownProjects() {
      return Object.values(registry).map(record => ({ projectId: record.projectId, name: record.name || 'Shared project', role: record.role, updatedAt: record.updatedAt })).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    }

    async function openKnown(projectId) {
      const record = registry[projectId];
      if (!record?.token) throw new Error('access_key_unavailable');
      return bootstrap(projectId, record.token);
    }

    function leave() {
      clearSubscriptions();
      active = null;
      role = 'viewer';
      revision = snapshotRevision = 0;
      versions = {};
      shadow = pendingWorld = null;
      simulationStatus = 'paused';
      controller = false;
      const url = new URL(global.location.href);
      url.hash = '';
      global.history?.replaceState?.(null, '', url);
      global.document?.body?.classList.remove('collaboration-linked');
      hooks.onPresence?.([]);
      emitStatus('local');
    }

    const editableWorld = () => shadow ? clone(shadow) : null;
    const close = () => {
      closed = true;
      clearSubscriptions();
      client?.close?.();
    };

    return {
      available: () => Boolean(client),
      active: () => Boolean(active),
      canEdit: () => !active || role !== 'viewer',
      isOwner: () => Boolean(active && role === 'owner'),
      role: () => active ? role : 'local',
      sessionId: guest.sessionId,
      configure,
      joinFromLocation,
      createOnline,
      bootstrap,
      projectChanged,
      flush,
      checkpoint,
      editableWorld,
      shareInfo,
      createAccess,
      listCapabilities,
      revokeCapability,
      listRevisions,
      restoreRevision,
      recoveryData,
      analyticsTransport,
      listKnownProjects,
      openKnown,
      leave,
      setPresence,
      startSimulation,
      pauseSimulation,
      resetSimulation,
      publishSimulation,
      splitUtf8,
      errorCode,
      close,
    };
  }

  global.PrototeerCollaboration = { create, splitUtf8, accessUrl };
})(globalThis);
