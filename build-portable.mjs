import {mkdir,readFile,writeFile} from 'node:fs/promises';import {pathToFileURL} from 'node:url';import {resolve} from 'node:path';
export async function buildPortable(options={}){
 const [html,css,convexClient,operations,analytics,collaboration,engine,store,app]=await Promise.all(['public/index.html','public/style.css','node_modules/convex/dist/browser.bundle.js','public/project-operations.js','public/analytics.js','public/collaboration.js','public/engine.js','browser-store.js','public/app.js'].map(f=>readFile(new URL(f,import.meta.url),'utf8')));
 const declarations=engine.replace(/\bexport\s+(?=(?:const|function|class|async)\b)/g,'');
 const storage=store.replace(/\bexport\s+(?=function\b)/g,'');
 const editor=app.replace(/^import[^\n]*from '\.\/engine\.js';\r?\n/,'');
 if(/^import /m.test(editor)||/\bexport /m.test(declarations))throw new Error('Unexpected module declaration in portable bundle.');
 const cleanConvexClient=convexClient.replace(/[ \t]+(?=\r?\n)/g,'');
 const js='(()=>{\nif(globalThis.location?.protocol==="file:"){const link=document.getElementById("downloadPortable");if(link)link.hidden=true;}\n'+cleanConvexClient+'\nglobalThis.convex=convex;\n'+operations+'\n'+analytics+'\n'+collaboration+'\n'+declarations+'\n'+storage+'\nlet storageFactory;try{storageFactory=globalThis.indexedDB;}catch{}globalThis.PrototeerStorage=createProjectStore(storageFactory,validWorld,MAX_BYTES);\n'+editor+'\n})();';
 const convexUrl=String(options.convexUrl??'').trim();
 const document=html.replace('content=""',`content="${convexUrl.replace(/[&"<>]/g,'')}"`).replace('<button id="projects">Projects</button>','<a class="download-zip" id="downloadPortable" href="./Prototeer.zip" download>Download ZIP</a><button id="projects">Projects</button>').replace('<link rel="stylesheet" href="/style.css">',()=>'<style>\n'+css.replace(/<\/style/gi,'<\\/style')+'\n</style>').replace('<script src="/convex-client.js"></script>','').replace('<script src="/project-operations.js"></script>','').replace('<script src="/analytics.js"></script>','').replace('<script src="/collaboration.js"></script>','').replace('<script type="module" src="/app.js"></script>',()=>'<script>\n'+js.replace(/<\/script/gi,'<\\/script')+'\n</script>').replace('class="brand" href="/"','class="brand" href="./index.html"');
 if(document.includes('type="module"')||document.includes('fonts.googleapis.com'))throw new Error('Portable build contains an external dependency.');
 await mkdir(new URL('docs/dev/',import.meta.url),{recursive:true});await writeFile(new URL('docs/dev/index.html',import.meta.url),document);await writeFile(new URL('docs/dev/.nojekyll',import.meta.url),'');
 console.log('Built docs/dev/index.html: offline, self-contained, no server or dependencies.');return {document,js,css};
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)await buildPortable({convexUrl:process.env.PROTOTEER_CONVEX_URL});
