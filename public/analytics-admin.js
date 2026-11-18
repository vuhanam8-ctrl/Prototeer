(function installAnalyticsDesk(root){
  'use strict';

  const CONFIG_KEY='prototeer.analytics-admin-url.v1';
  const PAGE_SIZE=100;
  const EXPORT_PAGE_SIZE=250;
  const MAX_EXPORT_ROWS=100000;
  const EVENT_KINDS=['panel_opened','editor_opened','editor_completed','editor_cancelled','editor_abandoned','control_clicked','control_changed','board_mode_changed','board_stroke','node_created','node_connected','node_disconnected','node_moved','simulation_run','simulation_pause','simulation_step','simulation_reset','save_started','save_succeeded','save_failed','project_imported','project_exported','project_opened','validation_error','undo','redo'];
  const HEATMAP_KINDS=['click','pointer','scroll'];
  const COLUMNS={
    sessions:['sessionId','participantId','consentVersion','uiVersion','viewportWidth','viewportHeight','dpr','startedAt','endedAt','lastSeenAt','lastSequence','eventCount','heatmapCount'],
    events:['schemaVersion','eventId','sessionId','sequence','occurredAt','uiVersion','kind','surface','panel','controlId','flow','result','durationMs','viewportWidth','viewportHeight','dpr','context'],
    heatmap:['sessionId','uiVersion','surface','panel','kind','xBin','yBin','viewportBucket','pointerType','count','occurredAt'],
  };
  const $=id=>root.document.getElementById(id);
  const api=()=>root.convex?.anyApi?.analytics;
  let client=null;
  let adminKey='';
  let table='sessions';
  let page=[];
  let cursor=null;
  let nextCursor=null;
  let done=true;
  let cursorHistory=[];
  let pageIndex=0;
  let requestVersion=0;

  function validUrl(value){return /^https:\/\/[a-z0-9-]+\.convex\.cloud$/i.test(value)}
  function validKey(value){return /^[A-Za-z0-9_-]{43,256}$/.test(value)}
  function setState(state,label){$('connectionState').dataset.state=state;$('connectionState').textContent=label}
  function errorText(error){const value=String(error?.data?.message||error?.message||error||'');if(/admin|access|unauthor|key/i.test(value))return 'The analytics admin key was rejected.';if(/network|fetch|socket|connect/i.test(value))return 'The analytics backend could not be reached.';return 'The analytics request failed.'}
  function timestamp(value){if(!Number.isFinite(value))return value??'';try{return new Date(value).toISOString()}catch{return String(value)}}
  function displayValue(key,value){if(value===undefined||value===null)return '';if(key.endsWith('At'))return timestamp(value);if(typeof value==='object')return JSON.stringify(value);return String(value)}
  function html(value){return String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]))}
  function download(content,name,type){const url=URL.createObjectURL(new Blob([content],{type})),link=root.document.createElement('a');link.href=url;link.download=name;link.click();root.setTimeout(()=>URL.revokeObjectURL(url),1000)}
  function csvCell(value){const text=value===undefined||value===null?'':typeof value==='object'?JSON.stringify(value):String(value);return /[",\r\n]/.test(text)?`"${text.replace(/"/g,'""')}"`:text}
  function rowsCsv(rows){const fields=COLUMNS[table];return [fields.join(','),...rows.map(row=>fields.map(field=>csvCell(row[field])).join(','))].join('\r\n')}

  function filters(){
    const from=$('fromDate').value?new Date($('fromDate').value).getTime():undefined;
    const to=$('toDate').value?new Date($('toDate').value).getTime():undefined;
    return {
      ...(Number.isFinite(from)?{from}:{}),
      ...(Number.isFinite(to)?{to}:{}),
      ...($('surfaceFilter').value?{surface:$('surfaceFilter').value}:{}),
      ...($('panelFilter').value?{panel:$('panelFilter').value}:{}),
      ...($('kindFilter').value?{kind:$('kindFilter').value}:{}),
    };
  }

  function argsFor(type,targetCursor,numItems){
    const args={adminKey,paginationOpts:{cursor:targetCursor,numItems}};
    if(type==='sessions')return args;
    const selected=filters();
    if(type==='heatmap')delete selected.kind;
    return {...args,...selected};
  }

  function reference(type){
    const analytics=api();
    if(!analytics)throw new Error('Convex browser client is unavailable.');
    return type==='sessions'?analytics.exportSessions:type==='events'?analytics.exportEvents:analytics.exportHeatmap;
  }

  function updateKinds(){
    const select=$('kindFilter'),value=select.value,kinds=table==='events'?EVENT_KINDS:table==='heatmap'?HEATMAP_KINDS:[];
    select.innerHTML='<option value="">All</option>'+kinds.map(kind=>`<option value="${kind}">${kind}</option>`).join('');
    if(kinds.includes(value))select.value=value;
    select.closest('label').hidden=table!=='events';
    for(const id of ['fromDate','toDate','surfaceFilter','panelFilter'])$(id).closest('label').hidden=table==='sessions';
  }

  function render(){
    const fields=COLUMNS[table];
    $('tableHead').innerHTML='<tr>'+fields.map(field=>`<th scope="col">${html(field)}</th>`).join('')+'</tr>';
    $('tableBody').innerHTML=page.length?page.map(row=>'<tr>'+fields.map(field=>`<td title="${html(displayValue(field,row[field]))}">${html(displayValue(field,row[field]))}</td>`).join('')+'</tr>').join(''):`<tr class="empty"><td colspan="${fields.length}">No records on this page.</td></tr>`;
    $('pageSummary').textContent=`${page.length} raw ${table} record${page.length===1?'':'s'} on this page`;
    $('pageNumber').textContent=`Page ${pageIndex+1}`;
    $('previousPage').disabled=pageIndex===0;
    $('nextPage').disabled=done||!nextCursor;
  }

  async function load(targetCursor=null,{reset=false}={}){
    if(!client||!adminKey)return;
    const version=++requestVersion;
    setState('loading','Loading…');
    for(const button of [$('refresh'),$('previousPage'),$('nextPage')])button.disabled=true;
    try{
      const result=await client.query(reference(table),argsFor(table,targetCursor,PAGE_SIZE));
      if(version!==requestVersion)return;
      if(reset){cursorHistory=[];pageIndex=0;}
      cursor=targetCursor;
      page=Array.isArray(result?.page)?result.page:[];
      nextCursor=result?.continueCursor??null;
      done=result?.isDone===true;
      render();
      setState('ready','Private desk connected');
    }catch(error){
      if(version!==requestVersion)return;
      setState('error','Request failed');
      $('pageSummary').textContent=errorText(error);
      render();
    }
  }

  async function connect(event){
    event.preventDefault();
    $('loginError').textContent='';
    const deploymentUrl=$('deploymentUrl').value.trim().replace(/\/$/,''),key=$('adminKey').value.trim();
    if(!validUrl(deploymentUrl))return void($('loginError').textContent='Enter the deployed Convex URL.');
    if(!validKey(key))return void($('loginError').textContent='Enter the separate analytics admin key.');
    $('connect').disabled=true;
    setState('loading','Checking access…');
    try{
      client?.close?.();
      client=new root.convex.ConvexClient(deploymentUrl);
      adminKey=key;
      try{root.localStorage.setItem(CONFIG_KEY,deploymentUrl);}catch{}
      const result=await client.query(reference('sessions'),argsFor('sessions',null,1));
      if(!result||!Array.isArray(result.page))throw new Error('invalid_response');
      $('adminKey').value='';
      $('loginView').hidden=true;
      $('desk').hidden=false;
      $('lock').hidden=false;
      await load(null,{reset:true});
    }catch(error){
      adminKey='';
      client?.close?.();
      client=null;
      setState('error','Access rejected');
      $('loginError').textContent=errorText(error);
    }finally{$('connect').disabled=false;}
  }

  function lock(){
    requestVersion++;
    adminKey='';
    page=[];
    client?.close?.();
    client=null;
    $('desk').hidden=true;
    $('loginView').hidden=false;
    $('lock').hidden=true;
    $('adminKey').value='';
    setState('locked','Locked');
  }

  async function collectFiltered(){
    const output=[];
    let exportCursor=null;
    for(let batch=0;batch<Math.ceil(MAX_EXPORT_ROWS/EXPORT_PAGE_SIZE);batch++){
      const result=await client.query(reference(table),argsFor(table,exportCursor,EXPORT_PAGE_SIZE));
      output.push(...(result?.page??[]));
      if(result?.isDone)return output;
      exportCursor=result?.continueCursor;
      if(!exportCursor)break;
    }
    throw new Error(`Export stopped at ${MAX_EXPORT_ROWS} records. Narrow the date filters and try again.`);
  }

  async function exportRows(format){
    const button=format==='json'?$('exportJson'):$('exportCsv');
    button.disabled=true;
    const previous=$('pageSummary').textContent;
    $('pageSummary').textContent='Preparing the filtered export…';
    try{
      const rows=await collectFiltered(),stamp=new Date().toISOString().replace(/[:.]/g,'-');
      if(format==='json')download(JSON.stringify({schemaVersion:1,generatedAt:Date.now(),table,filters:filters(),rows},null,2),`prototeer-${table}-${stamp}.json`,'application/json');
      else download(rowsCsv(rows),`prototeer-${table}-${stamp}.csv`,'text/csv');
      $('pageSummary').textContent=`Exported ${rows.length} raw ${table} records.`;
    }catch(error){$('pageSummary').textContent=error.message||errorText(error);}
    finally{button.disabled=false;root.setTimeout(()=>{if($('pageSummary').textContent.startsWith('Exported'))$('pageSummary').textContent=previous;},4000);}
  }

  async function deleteAll(event){
    event.preventDefault();
    if(event.submitter?.id!=='confirmDelete')return void $('deleteDialog').close();
    if($('deleteConfirmation').value!=='DELETE')return void($('deleteError').textContent='Type DELETE exactly.');
    $('confirmDelete').disabled=true;
    $('deleteError').textContent='Deleting…';
    try{
      let total=0;
      for(let batch=0;batch<1000;batch++){
        const result=await client.mutation(api().clear,{adminKey});
        total+=Number(result?.deleted)||0;
        if(!result?.more){$('deleteDialog').close();$('deleteConfirmation').value='';await load(null,{reset:true});$('pageSummary').textContent=`Deleted ${total} analytics records.`;return;}
      }
      throw new Error('Deletion did not finish.');
    }catch(error){$('deleteError').textContent=error.message||errorText(error);}
    finally{$('confirmDelete').disabled=false;}
  }

  $('loginForm').addEventListener('submit',connect);
  $('lock').addEventListener('click',lock);
  $('refresh').addEventListener('click',()=>load(cursor));
  $('filters').addEventListener('submit',event=>{event.preventDefault();void load(null,{reset:true});});
  $('clearFilters').addEventListener('click',()=>{$('filters').reset();void load(null,{reset:true});});
  $('previousPage').addEventListener('click',()=>{if(!pageIndex)return;const prior=cursorHistory.pop()??null;pageIndex--;void load(prior);});
  $('nextPage').addEventListener('click',()=>{if(done||!nextCursor)return;cursorHistory.push(cursor);pageIndex++;void load(nextCursor);});
  $('exportJson').addEventListener('click',()=>void exportRows('json'));
  $('exportCsv').addEventListener('click',()=>void exportRows('csv'));
  $('deleteAll').addEventListener('click',()=>{$('deleteError').textContent='';$('deleteConfirmation').value='';$('deleteDialog').showModal();});
  $('deleteForm').addEventListener('submit',deleteAll);
  root.document.querySelectorAll('[data-table]').forEach(button=>button.addEventListener('click',()=>{
    table=button.dataset.table;
    root.document.querySelectorAll('[data-table]').forEach(tab=>tab.setAttribute('aria-selected',String(tab===button)));
    updateKinds();
    void load(null,{reset:true});
  }));

  let storedUrl='';
  try{storedUrl=root.localStorage.getItem(CONFIG_KEY)||'';}catch{}
  const configured=root.document.querySelector('meta[name="prototeer-convex-url"]')?.content?.trim()||storedUrl;
  if(validUrl(configured))$('deploymentUrl').value=configured;
  updateKinds();
})(globalThis);
