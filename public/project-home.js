(function installProjectHome(global) {
  'use strict';

  const localPrefix = 'prototeer.project-home.local.';
  const sharedPrefix = 'prototeer.project-home.shared.';
  const validId = /^[A-Za-z0-9_-]{16,80}$/;
  const validToken = /^[A-Za-z0-9_-]{43,256}$/;
  const roleRank = { viewer: 0, editor: 1, owner: 2 };

  function start({ api, createBoard, openLocal, openShared, openLegacy, exitEditor, connect, collaboration, chooseImport, openDemo, download, copy, toast, record, previewOf }) {
    const $ = id => global.document.getElementById(id);
    const online = collaboration?.workspaces;
    let project = null;
    let inEditor = false;
    let busy = false;
    let subscription;
    let pendingBoard = null;
    let boardRender = 0;
    let boardNameAction = null;
    let boardToDelete = null;
    let projectToDelete = null;

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
      for (const id of ['frontLobby', 'projectLobby', 'projectPage', 'editorShell']) $(id).hidden = id !== page;
      if (page !== 'projectPage') boardRender++;
      $('editorBackToProject').hidden = !project;
      $('editorAddBoard').hidden = !project || project.role === 'viewer';
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
      return { item, button };
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
            pause_before_editing: 'Pause the board before renaming it.',
            checkpoint_required: 'Open the board and save it before renaming.',
          }[code] ?? (typeof code === 'string' && /[ .]/.test(code) && !code.includes('[CONVEX')
            ? code : 'Could not complete this action. Try again.');
          status(statusId === 'frontStatus' && !$('projectPage').hidden ? 'projectPageStatus' : statusId, message);
          if (inEditor) toast(message);
        } finally { busy = false; }
      };
    }

    function stopWatching() {
      subscription?.();
      subscription = null;
    }

    function showFront() {
      stopWatching();
      pendingBoard = null;
      project = null;
      setRoute();
      show('frontLobby');
      status('frontStatus');
    }

    function projectRow(list, entry) {
      const { item } = buttonRow(list, entry.name, exclusive('lobbyStatus', () => openProject(entry)));
      if (entry.role !== 'owner') return;
      const actions = global.document.createElement('div');
      actions.classList.add('board-card-actions');
      const button = global.document.createElement('button');
      button.type = 'button';
      button.textContent = 'Delete Project';
      button.setAttribute('aria-label', 'Delete project ' + entry.name);
      button.onclick = () => showProjectDelete(entry);
      actions.append(button);
      item.append(actions);
    }

    async function showLobby() {
      stopWatching();
      pendingBoard = null;
      project = null;
      show('projectLobby');
      setRoute({ projects: '1' });
      const list = $('lobbyProjectList');
      list.replaceChildren();
      status('lobbyStatus');
      const local = records(localPrefix);
      const shared = records(sharedPrefix);
      const sharedIds = new Set(shared.map(entry => entry.publicId));
      for (const entry of [...local.filter(entry => !sharedIds.has(entry.sharedId)), ...shared].filter(entry => !entry.deleted)
        .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))) {
        projectRow(list, entry);
      }
      try {
        const saved = await api('projects');
        const grouped = new Set(local.flatMap(entry => [
          ...entry.boards.map(board => board.publicId), ...(entry.deletedBoardIds ?? []),
        ]));
        for (const world of saved) {
          if (grouped.has(world.id)) continue;
          const entry = {
            publicId: world.id, name: world.name, role: 'owner',
            boards: [{ publicId: world.id, name: world.name }],
          };
          projectRow(list, entry);
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

    async function fillMissingPreviews(entry, cards, render) {
      for (const { board, canvas } of cards) {
        if (render !== boardRender) return;
        try {
          const world = await api('projects/' + board.publicId);
          if (render !== boardRender || project?.publicId !== entry.publicId) return;
          const preview = previewOf(world);
          global.PrototeerBoardPreview.update(canvas, preview);
          updateBoardSummary(world, preview);
        } catch {
          // The grid remains visible if a saved board cannot be read.
        }
      }
    }

    function renderBoards() {
      $('projectPageTitle').textContent = project.name;
      $('projectAddBoard').hidden = project.role === 'viewer';
      $('projectInvite').hidden = project.role !== 'owner';
      $('projectDelete').hidden = project.role !== 'owner';
      $('projectBoardsEmpty').hidden = project.boards.length > 0;
      const list = $('projectBoardList');
      list.replaceChildren();
      const missing = [];
      const render = ++boardRender;
      for (const board of project.boards) {
        const { item, button } = buttonRow(list, board.name, exclusive('projectPageStatus', () => showBoard(board.publicId)));
        button.classList.add('board-card');
        const canvas = global.document.createElement('canvas');
        canvas.classList.add('board-card-preview');
        canvas.width = 384;
        canvas.height = 240;
        canvas.setAttribute('aria-hidden', 'true');
        const title = global.document.createElement('span');
        title.classList.add('board-card-title');
        title.textContent = board.name;
        button.replaceChildren(canvas, title);
        if (project.role !== 'viewer') {
          const actions = global.document.createElement('div');
          actions.classList.add('board-card-actions');
          const actionButton = (label, onClick) => {
            const action = global.document.createElement('button');
            action.type = 'button';
            action.textContent = label;
            action.setAttribute('aria-label', label + ' ' + board.name);
            action.onclick = onClick;
            actions.append(action);
          };
          actionButton('Rename', () => showBoardNameDialog(board));
          if (project.role === 'owner') actionButton('Delete', () => showBoardDeleteDialog(board));
          item.append(actions);
        }
        global.PrototeerBoardPreview?.update(canvas, board.preview);
        if (!project.shared && previewOf && typeof board.preview !== 'string') missing.push({ board, canvas });
      }
      if (missing.length) void fillMissingPreviews(project, missing, render);
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
        const changed = project.name !== updated.name || project.role !== updated.role ||
          project.boards.length !== updated.boards.length || updated.boards.some((board, index) => {
            const previous = project.boards[index];
            return board.publicId !== previous?.publicId || board.name !== previous.name || board.preview !== previous.preview;
          });
        project = { ...project, ...updated };
        if (changed) {
          rememberShared(project);
          if (!$('projectPage').hidden) renderBoards();
        }
      }, () => status('projectPageStatus', 'The project could not refresh. Check the link or your connection.'));
    }

    async function openProject(entry, boardId) {
      if (entry.deleted || (!entry.shared && stored(localPrefix + entry.publicId)?.deleted)) {
        throw new Error('This project was deleted.');
      }
      stopWatching();
      pendingBoard = null;
      if (entry.shared) {
        await selectDeployment(entry.backend);
        let current;
        try { current = await online.open(accessOf(entry)); }
        catch (error) {
          if (error?.data?.code === 'workspace_deleted') {
            rememberShared({ publicId: entry.publicId, role: 'owner', deleted: true });
            await showLobby();
            status('lobbyStatus', 'This project was deleted.');
            return;
          }
          throw error;
        }
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

    function updateBoardSummary(world, preview = previewOf?.(world)) {
      if (!project || project.shared) return;
      const latest = stored(localPrefix + project.publicId) ?? project;
      const board = latest.boards.find(board => board.publicId === world.id);
      if (!board || (board.name === world.name && board.preview === preview)) return;
      const updated = { ...latest, boards: latest.boards.map(item => item === board ? { ...item, name: world.name, preview } : item) };
      project = updated;
      try { rememberLocal(updated); } catch {
        // Board saves remain usable when thumbnail metadata cannot be cached.
      }
    }

    async function leaveWorkspace() {
      if (!inEditor) return;
      const saved = await exitEditor(Boolean(project?.shared));
      if (saved) updateBoardSummary(saved);
      inEditor = false;
    }

    async function returnToProject() {
      await leaveWorkspace();
      show('projectPage');
      setRoute(routeFor(project));
      renderBoards();
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
        boards: [{ publicId: world.id, name: world.name, preview: '' }] };
      await saveBoard(world);
      rememberLocal(entry);
      $('projectNameDialog').close();
      await openProject(entry);
    }

    function availableBoardName(entry) {
      const names = new Set(entry.boards.map(board => board.name));
      let number = 1;
      while (names.has('Board ' + number)) number++;
      return 'Board ' + number;
    }

    function showBoardNameDialog(board = null, openAfter = false) {
      if (!project || project.role === 'viewer') return;
      boardNameAction = { board, openAfter };
      const input = $('boardNameInput');
      input.value = board?.name ?? pendingBoard?.name ?? availableBoardName(project);
      $('boardNameTitle').textContent = board ? 'Rename Board' : 'Add Board';
      $('boardNameSubmit').textContent = board ? 'Rename board' : 'Create board';
      status('boardNameStatus');
      $('boardNameDialog').showModal();
      input.focus();
      input.select?.();
    }

    function showBoardDeleteDialog(board) {
      if (project?.role !== 'owner') return;
      boardToDelete = board;
      $('boardDeleteCopy').textContent = 'Remove “' + board.name + '” from this project?';
      status('boardDeleteStatus');
      $('boardDeleteDialog').showModal();
    }

    async function addBoard(name) {
      if (!project || project.role === 'viewer') return;
      const entry = project.shared ? project : stored(localPrefix + project.publicId) ?? project;
      if (entry.boards.length >= 50) throw new Error('board_limit_reached');
      pendingBoard ??= createBoard(name);
      if (entry.shared) {
        const added = await online.addBoard(accessOf(entry), pendingBoard.id, pendingBoard);
        if (added.name !== name) await online.renameBoard(entry.token, pendingBoard.id, name);
        const current = await online.open(accessOf(entry));
        project = { ...entry, ...current };
        rememberShared(project);
      } else {
        pendingBoard.name = name;
        await saveBoard(pendingBoard);
        const latest = stored(localPrefix + entry.publicId) ?? entry;
        const updated = { ...latest, updatedAt: Date.now(),
          boards: [...latest.boards, { publicId: pendingBoard.id, name: pendingBoard.name, preview: '' }] };
        rememberLocal(updated);
        project = updated;
      }
      const boardId = pendingBoard.id;
      pendingBoard = null;
      renderBoards();
      return boardId;
    }

    async function renameBoard(board, name) {
      if (board.name === name) return;
      const entry = project;
      if (entry.shared) {
        const info = await online.renameBoard(entry.token, board.publicId, name);
        project = { ...project, boards: project.boards.map(item => item.publicId === board.publicId ? info : item) };
        rememberShared(project);
      } else {
        const world = await api('projects/' + board.publicId);
        world.name = name;
        await saveBoard(world);
        updateBoardSummary(world);
      }
      renderBoards();
    }

    async function deleteLocalBoard(entry, board) {
      const latest = stored(localPrefix + entry.publicId) ?? entry;
      const removed = {
        ...latest, boards: latest.boards.filter(item => item.publicId !== board.publicId),
        deletedBoardIds: [...new Set([...(latest.deletedBoardIds ?? []), board.publicId])],
      };
      rememberLocal(removed);
      try {
        await api('projects/' + board.publicId, { method: 'DELETE' });
      } catch (error) {
        const current = stored(localPrefix + entry.publicId) ?? removed;
        const boards = [...current.boards];
        const previousIndex = latest.boards.findIndex(item => item.publicId === board.publicId);
        if (previousIndex >= 0 && !boards.some(item => item.publicId === board.publicId)) {
          boards.splice(previousIndex, 0, latest.boards[previousIndex]);
        }
        rememberLocal({ ...current, boards, deletedBoardIds: current.deletedBoardIds?.filter(id => id !== board.publicId) });
        throw error;
      }
      return removed;
    }

    async function deleteBoard(board) {
      const entry = project;
      if (entry.shared) {
        await online.deleteBoard(entry.token, board.publicId);
        project = { ...project, boards: project.boards.filter(item => item.publicId !== board.publicId) };
        rememberShared(project);
      } else {
        project = await deleteLocalBoard(entry, board);
      }
      renderBoards();
    }

    function boardFeedback(message) {
      status('projectPageStatus', message);
      toast(message);
    }

    async function saveBoardName() {
      const name = $('boardNameInput').value.trim();
      if (!name) throw new Error('Enter a board name.');
      const { board, openAfter } = boardNameAction;
      if (board) {
        await renameBoard(board, name);
        $('boardNameDialog').close();
        boardFeedback('Renamed board to “' + name + '”.');
        return;
      }
      if (openAfter && inEditor) await returnToProject();
      const id = await addBoard(name);
      $('boardNameDialog').close();
      if (!id) return;
      boardFeedback('Added board “' + name + '”.');
      if (openAfter) {
        try { await showBoard(id); }
        catch { status('projectPageStatus', 'Added “' + name + '”. Select it to try opening it again.'); }
      }
    }

    async function confirmBoardDelete() {
      if (project?.role !== 'owner' || !boardToDelete) return;
      const board = boardToDelete;
      await deleteBoard(board);
      $('boardDeleteDialog').close();
      boardFeedback('Deleted board “' + board.name + '”.');
    }

    function showProjectDelete(entry) {
      if (entry?.role !== 'owner') return;
      projectToDelete = entry;
      $('projectDeleteCopy').textContent = 'Delete “' + entry.name + '” and all its boards?' +
        (entry.shared ? ' Its invite links will stop working.' : '');
      status('projectDeleteStatus');
      $('projectDeleteDialog').showModal();
    }

    async function confirmProjectDelete() {
      const entry = projectToDelete;
      if (entry?.role !== 'owner') return;
      if (entry.shared) {
        await selectDeployment(entry.backend);
        await online.deleteProject(accessOf(entry));
        rememberShared({ publicId: entry.publicId, role: 'owner', deleted: true });
      } else {
        const latest = stored(localPrefix + entry.publicId) ?? entry;
        if (latest.upload) {
          await selectDeployment(latest.upload.backend);
          try { await online.deleteProject(accessOf(latest.upload)); }
          catch (error) { if (error?.data?.code !== 'access_denied') throw error; }
        }
        let remaining = latest;
        for (const board of latest.boards) {
          remaining = await deleteLocalBoard(remaining, board);
          if (project?.publicId === entry.publicId) project = remaining;
        }
        rememberLocal({ ...remaining, deleted: true });
      }
      $('projectDeleteDialog').close();
      await showLobby();
      const message = 'Deleted project “' + entry.name + '”.';
      status('lobbyStatus', message);
      toast(message);
    }

    async function publishProject() {
      const entry = stored(localPrefix + project.publicId) ?? project;
      if (!entry.boards.length) throw new Error('Add a board before inviting someone.');
      const endpoint = online.url();
      const upload = entry.upload?.backend === endpoint ? entry.upload : {
        publicId: online.token(24), token: online.token(), backend: endpoint, boardIds: {},
      };
      for (const board of entry.boards) upload.boardIds[board.publicId] ??= online.token(24);
      rememberLocal({ ...entry, upload });
      const access = accessOf(upload);
      const boardIds = [];
      upload.snapshots ??= {};
      let stagedProject;
      if (Object.keys(upload.snapshots).length) {
        try { stagedProject = await online.open(access); }
        catch (error) { if ((error?.data?.code ?? error?.message) !== 'access_denied') throw error; }
      }
      if (stagedProject) {
        const selected = new Set(entry.boards.map(board => upload.boardIds[board.publicId]));
        const staged = new Set(Object.values(upload.boardIds));
        for (const board of stagedProject.boards) {
          if (staged.has(board.publicId) && !selected.has(board.publicId)) await online.deleteBoard(access.token, board.publicId);
        }
      }
      for (const board of entry.boards) {
        const world = await api('projects/' + board.publicId);
        const onlineId = upload.boardIds[board.publicId];
        const fingerprint = world.updated ?? null;
        if (!(onlineId in upload.snapshots)) {
          upload.snapshots[onlineId] = fingerprint;
          rememberLocal({ ...entry, upload });
        }
        if (!stagedProject && !boardIds.length) await online.create(upload.publicId, upload.token, entry.name, onlineId, world);
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
      showInviteAvailability();
      $('projectInviteDialog').showModal();
      void refreshGrants(project).catch(() => {});
    }

    function showInviteAvailability() {
      status('projectInviteStatus', !online?.desktop()
        ? 'Open this project on desktop to invite someone.'
        : collaboration.available() ? '' : 'Connect a deployed Convex backend to create an invite link.');
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

    $('frontNewProject').onclick = $('lobbyNewProject').onclick = openNameDialog;
    $('frontProjects').onclick = exclusive('lobbyStatus', showLobby);
    $('projectsBackToFront').onclick = exclusive('frontStatus', showFront);
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
    $('frontDemo').onclick = $('lobbyDemo').onclick = launchDemo;
    $('projectAddBoard').onclick = () => showBoardNameDialog();
    $('projectBackToLobby').onclick = exclusive('projectPageStatus', showFront);
    $('editorBackToProject').onclick = exclusive('projectPageStatus', returnToProject);
    $('editorAddBoard').onclick = () => showBoardNameDialog(null, true);
    $('projectDelete').onclick = () => showProjectDelete(project);
    for (const [prefix, action] of [['boardName', saveBoardName], ['boardDelete', confirmBoardDelete], ['projectDelete', confirmProjectDelete]]) {
      const dialog = $(prefix + 'Dialog');
      $(prefix + 'Cancel').onclick = () => { if (!busy) dialog.close(); };
      dialog.oncancel = event => { if (busy) event.preventDefault(); };
      $(prefix + 'Form').onsubmit = event => {
        event.preventDefault();
        if (!dialog.open) return;
        return exclusive(prefix + 'Status', async () => {
          const submit = $(prefix + 'Submit');
          submit.disabled = true;
          try { await action(); }
          finally { submit.disabled = false; }
        })();
      };
    }
    $('projectInvite').onclick = inviteDialog;
    $('projectInviteClose').onclick = () => $('projectInviteDialog').close();
    $('projectInviteCopy').onclick = () => copy($('projectInviteLink').value);
    $('projectInviteRole').onchange = () => {
      $('projectInviteLink').value = '';
      $('projectInviteResult').hidden = true;
      showInviteAvailability();
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
        catch (error) { show('frontLobby'); throw error; }
      } else if (validId.test(local)) {
        const known = stored(localPrefix + local);
        const world = known ? null : await api('projects/' + local);
        await openProject(known ?? { publicId: local, name: world.name, role: 'owner', boards: [{ publicId: local, name: world.name }] }, board);
      } else if (params.get('projects') === '1') {
        await showLobby();
      } else {
        showFront();
      }
    }

    void exclusive('frontStatus', restoreLocation)();
    return {
      launchDemo,
      isSharedBoard: () => Boolean(project?.shared && inEditor),
      lobby: exclusive('lobbyStatus', async () => { await leaveWorkspace(); await showLobby(); }),
      showStandalone: () => { stopWatching(); project = null; setRoute(); show('editorShell'); },
      openInvite: () => {
        if (!project) return false;
        if (project.role !== 'owner') { toast('Only the project owner can create invite links.'); return true; }
        void exclusive('projectPageStatus', async () => {
          await returnToProject();
          inviteDialog();
        })();
        return true;
      },
      updateBoardSummary,
      inEditor: () => inEditor,
    };
  }

  global.PrototeerProjectHome = { start };
})(globalThis);
