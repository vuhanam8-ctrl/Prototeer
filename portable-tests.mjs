import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {createProjectStore} from './browser-store.js';import {createDemoWorld,validWorld,MAX_BYTES} from './public/engine.js';import {bootEditor,createTestLocalStorage} from './editor-smoke.mjs';import {buildPortable} from './build-portable.mjs';
function fakeIndexedDB(){const values=new Map();let failed=false;return {failWrites(){failed=true;},open(){const req={};queueMicrotask(()=>{const db={objectStoreNames:{contains:()=>true},close(){},transaction(_name,mode){const tx={error:null,abort(){queueMicrotask(()=>tx.onabort?.());},objectStore(){function request(action){const r={};queueMicrotask(()=>{if(failed&&mode==='readwrite'){tx.error=new Error('Quota exceeded');tx.onabort?.();return;}r.result=structuredClone(action());r.onsuccess?.();queueMicrotask(()=>tx.oncomplete?.());});return r;}return {get:key=>request(()=>values.get(key)),getAll:()=>request(()=>[...values.values()]),put:value=>request(()=>{values.set(value.id,structuredClone(value));return value.id;})};}};return tx;}};req.result=db;req.onsuccess?.();});return req;}};}
test('portable artifact has no module, network, absolute asset or font dependencies',async()=>{const {document,adminDocument,js}=await buildPortable();assert.ok(!/^\s*(?:import|export)\s/m.test(js));assert.ok(!/<(?:script|link)[^>]+(?:src|href)=/i.test(document));assert.ok(!/<(?:script|link)[^>]+(?:src|href)=/i.test(adminDocument));assert.ok(!document.includes('fonts.googleapis.com'));assert.ok(document.includes('href="./index.html"'));assert.ok(!document.includes('analytics-admin'));assert.match(adminDocument,/noindex,nofollow,noarchive/);new vm.Script(js);});
test('browser project store saves independent full projects with art, memory, and editable definitions',async()=>{const idb=fakeIndexedDB(),store=createProjectStore(idb,validWorld,MAX_BYTES),world=createDemoWorld();world.tools[0].image='data:image/png;base64,iVBORw0KGgo=';await store.request('projects/'+world.id,{method:'PUT',body:JSON.stringify(world)});const secondClient=createProjectStore(idb,validWorld,MAX_BYTES),saved=await secondClient.request('projects/'+world.id);assert.deepEqual(saved.tools,world.tools);assert.deepEqual(saved.zones,world.zones);assert.deepEqual(saved.directors,world.directors);assert.ok(validWorld(saved));saved.name='mutated copy';assert.notEqual((await store.request('projects/'+world.id)).name,'mutated copy');assert.equal((await store.request('projects'))[0].id,world.id);await assert.rejects(store.request('projects/other',{method:'PUT',body:JSON.stringify(world)}),/Invalid project/);});
test('unavailable or full browser storage reports failure instead of a false saved state',async()=>{await assert.rejects(createProjectStore(undefined,validWorld,MAX_BYTES).request('projects'),/unavailable/);const idb=fakeIndexedDB(),store=createProjectStore(idb,validWorld,MAX_BYTES),world=createDemoWorld();idb.failWrites();await assert.rejects(store.request('projects/'+world.id,{method:'PUT',body:JSON.stringify(world)}),/Quota/);assert.deepEqual(await store.request('projects'),[]);});
test('compiled file build opens the pursuit demo from the lobby and saves without fetching',async()=>{const {document,js}=await buildPortable(),idb=fakeIndexedDB();const {editor,get}=bootEditor({html:document,source:js,globals:{indexedDB:idb}});await new Promise(setImmediate);await get('lobbyDemo').onclick();assert.equal(get('editorShell').hidden,false);assert.equal(editor.world().zones.length,4);get('step').click();assert.equal(editor.world().tick,1);await get('save').onclick();assert.equal(get('saveState').textContent,'Saved');const savedId=editor.world().id;const store=createProjectStore(idb,validWorld,MAX_BYTES),saved=await store.request('projects/'+savedId);assert.equal(saved.tick,1);assert.ok(validWorld(saved));editor.adopt(saved);assert.equal(editor.world().tick,1);assert.equal(get('downloadPortable').hidden,true);});

test('a named project opens Board 1 and independently saves its boards in the offline lobby', async () => {
  const { document, js } = await buildPortable();
  const indexedDB = fakeIndexedDB();
  const localStorage = createTestLocalStorage();
  const boot = () => bootEditor({ html: document, source: js, globals: { indexedDB, localStorage } });
  const { editor, get } = boot();
  const settle = () => new Promise(setImmediate);
  const listButtons = (getElement, id) => getElement(id).children.map(item => item.children[0]);
  await settle();
  assert.equal(get('projectLobby').hidden, false);
  assert.equal(get('editorShell').hidden, true);
  get('lobbyNewProject').click();
  assert.equal(get('projectNameDialog').open, true);
  get('projectNameInput').value = '  Enemy patrol  ';
  get('projectNameForm').onsubmit({ preventDefault() {} });
  await settle();
  assert.equal(get('projectNameDialog').open, false);
  assert.equal(get('projectPage').hidden, false);
  assert.equal(get('projectPageTitle').textContent, 'Enemy patrol');
  const boards = () => listButtons(get, 'projectBoardList');
  assert.deepEqual(boards().map(button => button.textContent), ['Board 1']);
  get('projectInvite').click();
  assert.equal(get('projectInviteRole').value, 'viewer');
  get('projectInviteRole').value = 'editor';
  get('projectInviteClose').click();
  get('projectInvite').click();
  assert.equal(get('projectInviteRole').value, 'viewer');
  get('projectInviteClose').click();
  await boards()[0].onclick();
  assert.equal(get('editorShell').hidden, false);
  assert.equal(editor.world().name, 'Board 1');
  const firstId = editor.world().id;
  get('step').click();
  await get('save').onclick();
  await get('editorBackToProject').onclick();
  await get('projectAddBoard').onclick();
  assert.deepEqual(boards().map(button => button.textContent), ['Board 1', 'Board 2']);
  await boards()[1].onclick();
  assert.notEqual(editor.world().id, firstId);
  assert.equal(editor.world().tick, 0);
  await get('editorBackToProject').onclick();
  await boards()[0].onclick();
  assert.equal(editor.world().id, firstId);
  assert.equal(editor.world().tick, 1);
  const reopened = boot();
  await settle();
  const projects = listButtons(reopened.get, 'lobbyProjectList');
  assert.deepEqual(projects.map(button => button.textContent), ['Enemy patrol']);
  await projects[0].onclick();
  assert.deepEqual(listButtons(reopened.get, 'projectBoardList').map(button => button.textContent), ['Board 1', 'Board 2']);
});

test('a fresh viewer opens every board from a project invite without editor controls', async () => {
  const roles = new Map(), boards = new Map();
  let project, invitedRole;
  const backend = 'https://example.convex.cloud';
  const accessRole = ({ publicId, token }) => {
    assert.equal(publicId, project.publicId);
    return roles.get(token);
  };
  const fakeCollaboration = {
    create({ hooks }) {
      let role;
      return {
        active: () => Boolean(role), canEdit: () => role !== 'viewer', available: () => true,
        listKnownProjects: () => [], setPresence() {},
        async bootstrap(boardId, token) {
          role = roles.get(token);
          hooks.onBootstrap(structuredClone(boards.get(boardId)), { preserveUi: false });
          hooks.onStatus({ state: 'synced', active: true, role });
        },
        workspaces: {
          desktop: () => true, url: () => backend, token: () => crypto.randomUUID().replaceAll('-', '').repeat(2),
          async create(publicId, ownerToken, name, boardId, data) {
            project = { publicId, name };
            roles.set(ownerToken, 'owner');
            boards.set(boardId, structuredClone(data));
          },
          async open(access) {
            return { ...project, role: accessRole(access), boards: [...boards].map(([publicId, data]) => ({
              publicId, name: data.name,
            })) };
          },
          async addBoard(access, id, data) {
            assert.equal(accessRole(access), 'owner');
            boards.set(id, structuredClone(data));
          },
          async invite(access, token, grant, expectedBoardIds) {
            assert.equal(accessRole(access), 'owner');
            assert.deepEqual(Array.from(expectedBoardIds), [...boards.keys()]);
            invitedRole = grant;
            roles.set(token, grant);
          },
          subscribe: () => () => {},
          listCapabilities: async () => [],
        },
      };
    },
  };
  const boot = href => bootEditor({ loadProjectHome: true, globals: {
    location: { href },
    PrototeerCollaboration: fakeCollaboration,
    PrototeerStorage: createProjectStore(fakeIndexedDB(), validWorld, MAX_BYTES),
  } });
  const settle = () => new Promise(setImmediate);
  const { get } = boot('https://example.test/dev/');
  await settle();
  get('lobbyNewProject').click();
  get('projectNameInput').value = 'Patrol';
  get('projectNameForm').onsubmit({ preventDefault() {} });
  await settle();
  await get('projectAddBoard').onclick();
  get('projectInvite').click();
  get('projectInviteForm').onsubmit({ preventDefault() {} });
  await settle();
  assert.equal(invitedRole, 'viewer');
  assert.equal(get('projectInviteResult').hidden, false);
  const invite = new URL(get('projectInviteLink').value);
  assert.equal(invite.search, '');
  assert.equal(roles.get(new URLSearchParams(invite.hash.slice(1)).get('access')), 'viewer');

  const viewer = boot(invite.href);
  await settle();
  assert.equal(viewer.get('projectPage').hidden, false);
  assert.equal(viewer.get('projectPageTitle').textContent, 'Patrol', viewer.get('lobbyStatus').textContent);
  const viewerBoards = viewer.get('projectBoardList').children.map(item => item.children[0]);
  assert.deepEqual(viewerBoards.map(button => button.textContent), ['Board 1', 'Board 2']);
  assert.equal(viewer.get('projectAddBoard').hidden, true);
  assert.equal(viewer.get('projectInvite').hidden, true);
  await viewerBoards[1].onclick();
  assert.equal(viewer.get('editorShell').hidden, false);
  assert.equal(viewer.editor.world().name, 'Board 2');
  assert.equal(viewer.get('save').disabled, true);
});

test('file-mode save falls back to JSON download when browser storage is blocked',async()=>{const {document,js}=await buildPortable();const {get}=bootEditor({html:document,source:js,globals:{indexedDB:undefined}});await new Promise(setImmediate);await get('lobbyDemo').onclick();await get('save').onclick();assert.ok(get('toast').textContent.includes('Downloaded a project file'));assert.notEqual(get('saveState').textContent,'Saved');});

test('Unity export downloads selected mechanics and install tools from the offline editor', async () => {
  const {document, js, installer} = await buildPortable();
  const downloads = [];
  const {editor, get} = bootEditor({
    html: document, source: js,
    globals: {
      URL: class extends URL {
        static createObjectURL(blob) { downloads.push(blob); return 'blob:file'; }
        static revokeObjectURL() {}
      },
    },
  });
  await new Promise(setImmediate);
  await get('lobbyDemo').onclick();
  const world = createDemoWorld();
  world.tools[0].image = 'data:image/png;base64,iVBORw0KGgo=';
  editor.adopt(world);
  get('exportUnity').click();
  assert.equal(get('dialog').open, true);
  const inputs = get('dialogBody').querySelectorAll('[data-unity-type]');
  const pursuer = world.tools.find(tool => tool.name === 'Pursuer');
  for (const input of inputs) input.checked = input.value === pursuer.id;
  get('includeUnityTrees').onchange();
  assert.equal(get('downloadUnityExport').disabled, true);
  assert.match(get('unityExportIssues').innerHTML, /Unity/i);
  get('includeUnityTrees').checked = false;
  get('includeUnityTrees').onchange();
  assert.equal(get('downloadUnityExport').disabled, false);
  get('downloadUnityTools').click();
  assert.deepEqual(Buffer.from(await downloads[0].arrayBuffer()), installer);
  assert.match(installer.toString('latin1'), /Packages\/com\.prototeer\.unity\/package\.json/);
  get('downloadUnityExport').click();
  const data = JSON.parse(await downloads[1].text());
  assert.equal(data.format, 'prototeer-unity');
  assert.equal(data.formatVersion, 1);
  assert.deepEqual(data.tools.map(tool => tool.id), [pursuer.id]);
  assert.equal(data.tools[0].brainEnabled, false);
  assert.equal(data.tools[0].rules.length, pursuer.rules.length);
  assert.deepEqual(Object.keys(data).sort(), ['format','formatVersion','name','stats','tagDefs','tools','zones'].sort());
  get('export').click();
  const backup = JSON.parse(await downloads[2].text());
  assert.equal(backup.tools[0].image, world.tools[0].image);
  assert.ok(backup.entities.length);
  assert.ok(backup.directors.length);
});
