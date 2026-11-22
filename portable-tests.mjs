import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFile} from 'node:fs/promises';import {createProjectStore} from './browser-store.js';import {createDemoWorld,validWorld,MAX_BYTES} from './public/engine.js';import {bootEditor} from './editor-smoke.mjs';import {buildPortable} from './build-portable.mjs';
function fakeIndexedDB(){const values=new Map();let failed=false;return {failWrites(){failed=true;},open(){const req={};queueMicrotask(()=>{const db={objectStoreNames:{contains:()=>true},close(){},transaction(_name,mode){const tx={error:null,abort(){queueMicrotask(()=>tx.onabort?.());},objectStore(){function request(action){const r={};queueMicrotask(()=>{if(failed&&mode==='readwrite'){tx.error=new Error('Quota exceeded');tx.onabort?.();return;}r.result=structuredClone(action());r.onsuccess?.();queueMicrotask(()=>tx.oncomplete?.());});return r;}return {get:key=>request(()=>values.get(key)),getAll:()=>request(()=>[...values.values()]),put:value=>request(()=>{values.set(value.id,structuredClone(value));return value.id;})};}};return tx;}};req.result=db;req.onsuccess?.();});return req;}};}
test('portable artifact has no module, network, absolute asset or font dependencies',async()=>{const {document,adminDocument,js}=await buildPortable();assert.ok(!/^\s*(?:import|export)\s/m.test(js));assert.ok(!/<(?:script|link)[^>]+(?:src|href)=/i.test(document));assert.ok(!/<(?:script|link)[^>]+(?:src|href)=/i.test(adminDocument));assert.ok(!document.includes('fonts.googleapis.com'));assert.ok(document.includes('href="./index.html"'));assert.ok(!document.includes('analytics-admin'));assert.match(adminDocument,/noindex,nofollow,noarchive/);new vm.Script(js);});
test('browser project store saves independent full projects with art, memory, and editable definitions',async()=>{const idb=fakeIndexedDB(),store=createProjectStore(idb,validWorld,MAX_BYTES),world=createDemoWorld();world.tools[0].image='data:image/png;base64,iVBORw0KGgo=';await store.request('projects/'+world.id,{method:'PUT',body:JSON.stringify(world)});const secondClient=createProjectStore(idb,validWorld,MAX_BYTES),saved=await secondClient.request('projects/'+world.id);assert.deepEqual(saved.tools,world.tools);assert.deepEqual(saved.zones,world.zones);assert.deepEqual(saved.directors,world.directors);assert.ok(validWorld(saved));saved.name='mutated copy';assert.notEqual((await store.request('projects/'+world.id)).name,'mutated copy');assert.equal((await store.request('projects'))[0].id,world.id);await assert.rejects(store.request('projects/other',{method:'PUT',body:JSON.stringify(world)}),/Invalid project/);});
test('unavailable or full browser storage reports failure instead of a false saved state',async()=>{await assert.rejects(createProjectStore(undefined,validWorld,MAX_BYTES).request('projects'),/unavailable/);const idb=fakeIndexedDB(),store=createProjectStore(idb,validWorld,MAX_BYTES),world=createDemoWorld();idb.failWrites();await assert.rejects(store.request('projects/'+world.id,{method:'PUT',body:JSON.stringify(world)}),/Quota/);assert.deepEqual(await store.request('projects'),[]);});
test('compiled file build boots, runs, saves and reopens without any fetch calls',async()=>{const {document,js}=await buildPortable(),idb=fakeIndexedDB();const {editor,get}=bootEditor({html:document,source:js,globals:{indexedDB:idb,location:{protocol:'file:'}}});assert.equal(editor.world().zones.length,4);get('step').click();assert.equal(editor.world().tick,1);await get('save').onclick();assert.equal(get('saveState').textContent,'Saved');await get('projects').onclick();assert.ok(get('dialogBody').innerHTML.includes('Pursuit lab'));const savedId=editor.world().id;const store=createProjectStore(idb,validWorld,MAX_BYTES),saved=await store.request('projects/'+savedId);assert.equal(saved.tick,1);assert.ok(validWorld(saved));editor.adopt(saved);assert.equal(editor.world().tick,1);assert.equal(get('downloadPortable').hidden,true);});

test('file-mode save falls back to JSON download when browser storage is blocked',async()=>{const {document,js}=await buildPortable();const {get}=bootEditor({html:document,source:js,globals:{location:{protocol:'file:'},indexedDB:undefined}});await get('save').onclick();assert.ok(get('toast').textContent.includes('Downloaded a project file'));assert.notEqual(get('saveState').textContent,'Saved');});

test('Unity export downloads selected mechanics and install tools from the offline editor', async () => {
  const {document, js, installer} = await buildPortable();
  const downloads = [];
  const {editor, get} = bootEditor({
    html: document, source: js,
    globals: {
      location: {protocol: 'file:'},
      URL: {createObjectURL(blob) { downloads.push(blob); return 'blob:file'; }, revokeObjectURL() {}},
    },
  });
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
