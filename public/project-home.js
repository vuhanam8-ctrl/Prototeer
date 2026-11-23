(function installProjectHome(global) {
  'use strict';

  const localPrefix = 'prototeer.project-home.local.';
  const sharedPrefix = 'prototeer.project-home.shared.';
  const validId = /^[A-Za-z0-9_-]{16,80}$/;
  const validToken = /^[A-Za-z0-9_-]{43,256}$/;
  const roleRank = { viewer: 0, editor: 1, owner: 2 };

  function start({ api, createBoard, openLocal, openShared, openLegacy, exitEditor, connect, collaboration, chooseImport, openDemo, download, copy, toast, record }) {
    const $ = id => global.document.getElementById(id);
    const online = collaboration?.workspaces;
    let project = null;
    let inEditor = false;
    let busy = false;
    let subscription;
    let pendingBoard = null;

    function stored(key) {
      try { return JSON.parse(global.localStorage.getItem(key)); }
      catch { return null; }
    }

    function records(prefix) {
      try {
        return Object.keys(global.localStorage).filter(key => key.startsWith(prefix))
          .map(stored).filter(entry => entry && validId.test(entry.publicId));
      } catch { return []; }
    }

    function rememberLocal(entry) {
      global.localStorage.setItem(localPrefix + entry.publicId, JSON.stringify(entry));
    }

    function rememberShared(entry) {
      try {
        const previous = stored(sharedPrefix + entry.publicId);
        if (previous && roleRank[previous.role] > roleRank[entry.role]) return;
        global.localStorage.setItem(sharedPrefix + entry.publicId, JSON.stringify(entry));
      } catch {
        // Shared links still work without browser storage.
      }
    }

    function accessOf(entry) {
      return { publicId: entry.publicId, token: entry.token };
    }

    function setRoute(params = {}) {
      const url = new URL(global.location.href);
      url.hash = new URLSearchParams(params).toString();
      global.history.replaceState(null, '', url);
      global.document.body.classList.toggle('collaboration-linked', Boolean(params.workspace || params.project));
    }

    function routeFor(entry, boardId) {
      const params = entry.shared
        ? { workspace: entry.publicId, access: entry.token, backend: entry.backend }
        : { local: entry.publicId };
      if (boardId) params.board = boardId;
      return params;
    }

    function inviteUrl(entry, token) {
      const url = new URL(global.location.href);
      url.hash = new URLSearchParams(routeFor({ ...entry, token })).toString();
      return url.href;
    }

    function show(page) {
      inEditor = page === 'editorShell';
      for (const id of ['projectLobby', 'projectPage', 'editorShell']) $(id).hidden = id !== page;
      $('editorBackToProject').hidden = !project;
      $('projectName').setAttribute('aria-label', project ? 'Board name' : 'Project name');
    }

    function buttonRow(list, label, onClick) {
      const item = global.document.createElement('li');
      const button = global.document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.onclick = onClick;
      item.append(button);
      list.append(item);
    }

    function status(id, message = '') {
      $(id).textContent = message;
    }

    function exclusive(statusId, action) {
      return async () => {
        if (busy) return;
        busy = true;
        status(statusId);
        try { await action(); }
        catch (error) {
          const code = error?.data?.code ?? error?.message;
          const message = {
            desktop_required: 'Open this shared project on desktop.',
            online_backend_not_configured: 'Connect a Convex deployment to create an invite link.',
            invalid_convex_url: 'Enter a valid Convex deployment URL.',
            access_denied: 'This invite link is invalid or has been revoked.',
            project_not_found: 'This shared project is unavailable.',
            workspace_not_found: 'This shared project is unavailable.',
            project_too_large: 'A board exceeds 12 MB. Use smaller artwork files before sharing.',
            board_limit_reached: 'This project already has 50 boards.',
            access_link_limit_reached: 'This project has reached its invite link limit.',
          }[code] ?? (typeof code === 'string' && /[ .]/.test(code) && !code.includes('[CONVEX')
            ? code : 'Could not complete this action. Try again.');
          status(statusId, message);
          if (inEditor) toast(message);
        } finally { busy = false; }
      };
    }

    function stopWatching() {
      subscription?.();
      subscription = null;
    }

    async function showLobby() {
      stopWatching();
      pendingBoard = null;
      project = null;
      show('projectLobby');
      setRoute();
      const list = $('lobbyProjectList');
      list.replaceChildren();
      status('lobbyStatus');
      const local = records(localPrefix);
      const shared = records(sharedPrefix);
      const sharedIds = new Set(shared.map(entry => entry.publicId));
      for (const entry of [...local.filter(entry => !sharedIds.has(entry.sharedId)), ...shared]
        .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))) {
        buttonRow(list, entry.name, exclusive('lobbyStatus', () => openProject(entry)));
      }
      try {
        const saved = await api('projects');
        const grouped = new Set(local.flatMap(entry => entry.boards.map(board => board.publicId)));
        for (const world of saved) {
          if (grouped.has(world.id)) continue;
          const entry = {
            publicId: world.id, name: world.name, role: 'owner',
            boards: [{ publicId: world.id, name: world.name }],
          };
          buttonRow(list, world.name, exclusive('lobbyStatus', () => openProject(entry)));
        }
      } catch {
        status('lobbyStatus', 'Could not list browser saves. You can still import a project file.');
      }
      for (const entry of collaboration?.listKnownProjects() ?? []) {
        buttonRow(list, entry.name, exclusive('lobbyStatus', async () => {
          show('editorShell');
          try { await openLegacy(entry.projectId); }
          catch (error) { show('projectLobby'); throw error; }
        }));
      }
    }

    function renderBoards() {
      $('projectPageTitle').textContent = project.name;
      $('projectAddBoard').hidden = project.role === 'viewer';
      $('projectInvite').hidden = project.role !== 'owner';
      const list = $('projectBoardList');
      list.replaceChildren();
      for (const board of project.boards) {
        buttonRow(list, board.name, exclusive('projectPageStatus', () => showBoard(board.publicId)));
      }
    }

    async function selectDeployment(backend) {
      if (!online?.desktop()) throw new Error('desktop_required');
      if (backend && online.url() !== backend) await connect(backend);
      if (!collaboration.available()) throw new Error('online_backend_not_configured');
    }

    function watchSharedProject(entry) {
      const access = accessOf(entry);
      subscription = online.subscribe(access, updated => {
        if (project?.publicId !== access.publicId || project.token !== access.token) return;
        project = { ...project, ...updated };
        rememberShared(project);
        renderBoards();
      }, () => status('projectPageStatus', 'The project could not refresh. Check the link or your connection.'));
    }

    async function openProject(entry, boardId) {
      stopWatching();
      pendingBoard = null;
      if (entry.shared) {
        await selectDeployment(entry.backend);
        const current = await online.open(accessOf(entry));
        entry = { ...entry, ...current, backend: online.url(), updatedAt: Date.now() };
        rememberShared(entry);
      }
      project = entry;
      show('projectPage');
      setRoute(routeFor(project));
      status('projectPageStatus');
      renderBoards();
      if (project.shared) watchSharedProject(project);
      if (boardId && project.boards.some(board => board.publicId === boardId)) await showBoard(boardId);
      record?.('project_opened', { panel: 'projects' });
    }

    async function showBoard(boardId) {
      const entry = project;
      if (entry.shared) {
        await openShared(boardId, entry.token);
      } else {
        const board = await api('projects/' + boardId);
        openLocal(board);
      }
      show('editorShell');
      setRoute(routeFor(entry, boardId));
      record?.('project_opened', { panel: 'projects' });
    }

    async function saveBoard(world) {
      await api('projects/' + world.id, { method: 'PUT', body: JSON.stringify(world) });
    }

    function updateBoardName(id, name) {
      if (!project || project.shared) return;
      const latest = stored(localPrefix + project.publicId) ?? project;
      const board = latest.boards.find(board => board.publicId === id);
      if (!board || board.name === name) return;
      const updated = { ...latest, boards: latest.boards.map(board => board.publicId === id ? { ...board, name } : board) };
      rememberLocal(updated);
      project = updated;
    }

    async function leaveWorkspace() {
      if (!inEditor) return;
      const saved = await exitEditor(Boolean(project?.shared));
      if (saved) updateBoardName(saved.id, saved.name);
      inEditor = false;
    }

    function openNameDialog() {
      $('projectNameInput').value = '';
      status('projectNameStatus');
      $('projectNameDialog').showModal();
      $('projectNameInput').focus();
    }

    async function createProject() {
      const name = $('projectNameInput').value.trim();
      if (!name) throw new Error('Enter a project name.');
      await leaveWorkspace();
      const world = createBoard('Board 1');
      const entry = { publicId: global.crypto.randomUUID(), name, role: 'owner', updatedAt: Date.now(),
        boards: [{ publicId: world.id, name: world.name }] };
      await saveBoard(world);
      rememberLocal(entry);
      $('projectNameDialog').close();
      await openProject(entry);
    }

    async function addBoard() {
      if (!project || project.role === 'viewer') return;
      const entry = project.shared ? project : stored(localPrefix + project.publicId) ?? project;
      if (entry.boards.length >= 50) throw new Error('board_limit_reached');
      const names = new Set(entry.boards.map(board => board.name));
      let number = 1;
      while (names.has('Board ' + number)) number++;
      pendingBoard ??= createBoard('Board ' + number);
      if (entry.shared) {
        await online.addBoard(accessOf(entry), pendingBoard.id, pendingBoard);
        const current = await online.open(accessOf(entry));
        project = { ...entry, ...current };
        rememberShared(project);
      } else {
        await saveBoard(pendingBoard);
        const latest = stored(localPrefix + entry.publicId) ?? entry;
        const updated = { ...latest, updatedAt: Date.now(),
          boards: [...latest.boards, { publicId: pendingBoard.id, name: pendingBoard.name }] };
        rememberLocal(updated);
        project = updated;
      }
      pendingBoard = null;
      renderBoards();
    }

    async function publishProject() {
      const entry = stored(localPrefix + project.publicId) ?? project;
      const endpoint = online.url();
      const upload = entry.upload?.backend === endpoint ? entry.upload : {
        publicId: online.token(24), token: online.token(), backend: endpoint, boardIds: {},
      };
      for (const board of entry.boards) upload.boardIds[board.publicId] ??= online.token(24);
      rememberLocal({ ...entry, upload });
      const access = accessOf(upload);
      const boardIds = [];
      upload.snapshots ??= {};
      for (const board of entry.boards) {
        const world = await api('projects/' + board.publicId);
        const onlineId = upload.boardIds[board.publicId];
        const fingerprint = world.updated ?? null;
        if (!(onlineId in upload.snapshots)) {
          upload.snapshots[onlineId] = fingerprint;
          rememberLocal({ ...entry, upload });
        }
        if (!boardIds.length) await online.create(upload.publicId, upload.token, entry.name, onlineId, world);
        else await online.addBoard(access, onlineId, world);
        if (upload.snapshots[onlineId] !== fingerprint) {
          await online.updateDraftBoard(access, onlineId, world);
          upload.snapshots[onlineId] = fingerprint;
          rememberLocal({ ...entry, upload });
        }
        boardIds.push(onlineId);
      }
      const current = await online.open(access);
      const result = { ...access, ...current, backend: endpoint, shared: true, updatedAt: Date.now() };
      return { entry, shared: result, boardIds };
    }

    async function refreshGrants(entry) {
      const list = $('projectInviteGrants');
      list.replaceChildren();
      list.hidden = true;
      if (!entry?.shared || entry.role !== 'owner') return;
      const grants = await online.listCapabilities(accessOf(entry));
      if (!$('projectInviteDialog').open || project?.publicId !== entry.publicId) return;
      for (const grant of grants.filter(item => item.role !== 'owner' && !item.revokedAt)) {
        const item = global.document.createElement('li');
        const label = global.document.createElement('span');
        label.textContent = grant.label;
        const revoke = global.document.createElement('button');
        revoke.type = 'button';
        revoke.textContent = 'Revoke';
        revoke.setAttribute('aria-label', 'Revoke ' + grant.label + ' link');
        revoke.onclick = exclusive('projectInviteStatus', async () => {
          await online.revokeCapability(accessOf(entry), grant.id);
          $('projectInviteResult').hidden = true;
          status('projectInviteStatus', 'Link revoked.');
          await refreshGrants(entry);
        });
        item.append(label, revoke);
        list.append(item);
      }
      list.hidden = !list.childElementCount;
    }

    function inviteDialog() {
      if (project?.role !== 'owner') return;
      $('projectInviteRole').value = 'viewer';
      $('projectInviteResult').hidden = true;
      $('projectInviteLink').value = '';
      $('projectInviteBackendField').hidden = Boolean(collaboration?.available()) || !online?.desktop();
      $('projectInviteRecovery').hidden = !project.shared;
      status('projectInviteStatus', online?.desktop() ? '' : 'Open this project on desktop to invite someone.');
      $('projectInviteDialog').showModal();
      void refreshGrants(project).catch(() => {});
    }

    async function createInvite() {
      const role = $('projectInviteRole').value === 'editor' ? 'editor' : 'viewer';
      const endpoint = $('projectInviteBackendUrl').value.trim();
      await selectDeployment(collaboration?.available() ? '' : endpoint);
      $('projectInviteBackendField').hidden = true;
      const publication = project.shared ? null : await publishProject();
      const entry = publication?.shared ?? project;
      if (publication) {
        rememberShared(entry);
        const { upload, ...local } = publication.entry;
        rememberLocal({ ...local, sharedId: entry.publicId });
        project = entry;
        setRoute(routeFor(entry));
        renderBoards();
        watchSharedProject(entry);
        $('projectInviteRecovery').hidden = false;
      }
      const token = online.token();
      await online.invite(accessOf(entry), token, role, publication?.boardIds);
      $('projectInviteLink').value = inviteUrl(entry, token);
      $('projectInviteResult').hidden = false;
      await refreshGrants(entry).catch(() => {});
    }

    $('lobbyNewProject').onclick = openNameDialog;
    $('projectNameCancel').onclick = () => $('projectNameDialog').close();
    $('projectNameForm').onsubmit = event => {
      event.preventDefault();
      if (!$('projectNameInput').reportValidity()) return;
      void exclusive('projectNameStatus', createProject)();
    };
    $('lobbyImport').onclick = chooseImport;
    const launchDemo = exclusive('projectPageStatus', async () => {
      await leaveWorkspace();
      stopWatching();
      project = null;
      setRoute();
      openDemo();
      show('editorShell');
    });
    $('lobbyDemo').onclick = launchDemo;
    $('projectAddBoard').onclick = exclusive('projectPageStatus', addBoard);
    $('projectBackToLobby').onclick = exclusive('projectPageStatus', showLobby);
    $('editorBackToProject').onclick = exclusive('projectPageStatus', async () => {
      await leaveWorkspace();
      show('projectPage');
      setRoute(routeFor(project));
      renderBoards();
    });
    $('projectInvite').onclick = inviteDialog;
    $('projectInviteClose').onclick = () => $('projectInviteDialog').close();
    $('projectInviteCopy').onclick = () => copy($('projectInviteLink').value);
    $('projectInviteRole').onchange = () => {
      $('projectInviteLink').value = '';
      $('projectInviteResult').hidden = true;
      status('projectInviteStatus');
    };
    $('projectInviteRecovery').onclick = () => {
      if (!project?.shared || project.role !== 'owner') return;
      download({ type: 'prototeer-project-recovery', version: 1, projectName: project.name,
        url: inviteUrl(project, project.token) }, project.name + '-recovery-key');
    };
    $('projectInviteForm').onsubmit = event => {
      event.preventDefault();
      if (!$('projectInviteDialog').open) return;
      void exclusive('projectInviteStatus', async () => {
        const controls = ['projectInviteRole', 'projectInviteSubmit', 'projectInviteClose'];
        for (const control of controls) $(control).disabled = true;
        try { await createInvite(); }
        finally { for (const control of controls) $(control).disabled = false; }
      })();
    };

    async function restoreLocation() {
      const params = new URLSearchParams(global.location.hash.slice(1));
      const workspace = params.get('workspace');
      const local = params.get('local');
      const board = params.get('board');
      if (validId.test(workspace) && validToken.test(params.get('access'))) {
        global.document.body.classList.add('collaboration-linked');
        await openProject({ publicId: workspace, token: params.get('access'), backend: params.get('backend') || '', shared: true }, board);
      } else if (validId.test(params.get('project')) && validToken.test(params.get('access'))) {
        show('editorShell');
        try { await openLegacy(); }
        catch (error) { show('projectLobby'); throw error; }
      } else if (validId.test(local)) {
        const known = stored(localPrefix + local);
        const world = known ? null : await api('projects/' + local);
        await openProject(known ?? { publicId: local, name: world.name, role: 'owner', boards: [{ publicId: local, name: world.name }] }, board);
      } else {
        await showLobby();
      }
    }

    void exclusive('lobbyStatus', restoreLocation)();
    return {
      newProject: openNameDialog,
      launchDemo,
      isSharedBoard: () => Boolean(project?.shared && inEditor),
      lobby: exclusive('lobbyStatus', async () => { await leaveWorkspace(); await showLobby(); }),
      showStandalone: () => { stopWatching(); project = null; setRoute(); show('editorShell'); },
      openInvite: () => {
        if (!project) return false;
        if (project.role !== 'owner') { toast('Only the project owner can create invite links.'); return true; }
        void exclusive('projectPageStatus', async () => {
          await leaveWorkspace();
          show('projectPage');
          setRoute(routeFor(project));
          renderBoards();
          inviteDialog();
        })();
        return true;
      },
      updateBoardName,
      inEditor: () => inEditor,
    };
  }

  global.PrototeerProjectHome = { start };
})(globalThis);
