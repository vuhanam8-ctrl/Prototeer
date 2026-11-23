import {mkdir,readFile,writeFile} from 'node:fs/promises';import {pathToFileURL} from 'node:url';import {resolve} from 'node:path';
import {buildUnityInstaller} from './unity-package.mjs';
export async function buildPortable(options={}){
 const [installer,html,css,convexClient,operations,analytics,collaboration,projectHome,engine,unityExport,store,app,adminHtml,adminCss,adminApp]=await Promise.all([
  buildUnityInstaller(),
  ...['public/index.html','public/style.css','node_modules/convex/dist/browser.bundle.js','public/project-operations.js','public/analytics.js','public/collaboration.js','public/project-home.js','public/engine.js','public/unity-export.js','browser-store.js','public/app.js','public/analytics-admin.html','public/analytics-admin.css','public/analytics-admin.js'].map(f=>readFile(new URL(f,import.meta.url),'utf8')),
 ]);
 const declarations=engine.replace(/\bexport\s+(?=(?:const|function|class|async)\b)/g,'');
 const unity=unityExport.replace(/^import[^\n]*from '\.\/engine\.js';\r?\n/gm,'').replace(/\bexport\s+(?=(?:const|function|class|async)\b)/g,'');
 const storage=store.replace(/\bexport\s+(?=function\b)/g,'');
 const editor=app.replace(/^import[^\n]*from '\.\/(?:engine|unity-export)\.js';\r?\n/gm,'');
 if(/^\s*(?:import|export)\s/m.test(editor+'\n'+declarations+'\n'+unity))throw new Error('Unexpected module declaration in portable bundle.');
 const cleanConvexClient=convexClient.replace(/[ \t]+(?=\r?\n)/g,'');
 const js='(()=>{\nif(globalThis.location?.protocol==="file:"){const link=document.getElementById("downloadPortable");if(link)link.hidden=true;}\n'+cleanConvexClient+'\nglobalThis.convex=convex;\n'+operations+'\n'+analytics+'\n'+collaboration+'\n'+projectHome+'\n'+declarations+'\n'+unity+'\nglobalThis.PROTOTEER_UNITY_INSTALLER_BASE64='+JSON.stringify(installer.toString('base64'))+';\n'+storage+'\nlet storageFactory;try{storageFactory=globalThis.indexedDB;}catch{}globalThis.PrototeerStorage=createProjectStore(storageFactory,validWorld,MAX_BYTES);\n'+editor+'\n})();';
 const convexUrl=String(options.convexUrl??'').trim(),safeConvexUrl=convexUrl.replace(/[&"<>]/g,'');
 const document=html.replace('content=""',`content="${safeConvexUrl}"`).replace('<button id="projects">Projects</button>','<a class="download-zip" id="downloadPortable" href="./Prototeer.zip" download>Download ZIP</a><button id="projects">Projects</button>').replace('<link rel="stylesheet" href="/style.css">',()=>'<style>\n'+css.replace(/\r\n/g,'\n').replace(/<\/style/gi,'<\\/style')+'\n</style>').replace('<script src="/convex-client.js"></script>','').replace('<script src="/project-operations.js"></script>','').replace('<script src="/analytics.js"></script>','').replace('<script src="/collaboration.js"></script>','').replace('<script src="/project-home.js"></script>','').replace('<script type="module" src="/app.js"></script>',()=>'<script>\n'+js.replace(/<\/script/gi,'<\\/script')+'\n</script>').replace('class="brand" href="/"','class="brand" href="./index.html"');
 const adminDocument=adminHtml.replace('content=""',`content="${safeConvexUrl}"`).replace('<link rel="stylesheet" href="./analytics-admin.css">',()=>'<style>\n'+adminCss.replace(/<\/style/gi,'<\\/style')+'\n</style>').replace('<script src="/convex-client.js"></script>',()=>'<script>\n'+(cleanConvexClient+'\nglobalThis.convex=convex;').replace(/<\/script/gi,'<\\/script')+'\n</script>').replace('<script src="./analytics-admin.js"></script>',()=>'<script>\n'+adminApp.replace(/<\/script/gi,'<\\/script')+'\n</script>');
 if(document.includes('type="module"')||document.includes('fonts.googleapis.com'))throw new Error('Portable build contains an external dependency.');
 await mkdir(new URL('docs/dev/',import.meta.url),{recursive:true});await writeFile(new URL('docs/dev/index.html',import.meta.url),document);await writeFile(new URL('docs/dev/analytics-admin.html',import.meta.url),adminDocument);await writeFile(new URL('docs/dev/.nojekyll',import.meta.url),'');await writeFile(new URL('docs/dev/Prototeer.Unity.zip',import.meta.url),installer);
 console.log('Built docs/dev/index.html, the private analytics desk, and Prototeer.Unity.zip.');return {document,adminDocument,js,css,installer};
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)await buildPortable({convexUrl:process.env.PROTOTEER_CONVEX_URL});
