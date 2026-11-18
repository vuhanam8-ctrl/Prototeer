import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const [customerHtml,customerApp,collaboration,adminHtml,adminJs]=await Promise.all([
  readFile(new URL('public/index.html',import.meta.url),'utf8'),
  readFile(new URL('public/app.js',import.meta.url),'utf8'),
  readFile(new URL('public/collaboration.js',import.meta.url),'utf8'),
  readFile(new URL('public/analytics-admin.html',import.meta.url),'utf8'),
  readFile(new URL('public/analytics-admin.js',import.meta.url),'utf8'),
]);

assert.doesNotMatch(customerHtml,/id=["']research["']|analytics-admin|Export analytics|Delete collected data/i,'customer interface must not expose analytics administration');
assert.match(customerHtml,/id=["']export["']/,'customers must retain ordinary project export');
assert.doesNotMatch(customerApp,/researchDialog|exportAnalytics|deleteAnalyticsData/,'customer app must not contain analytics administration');
assert.doesNotMatch(collaboration,/exportAnalytics|deleteAnalytics/,'shared-project roles must not receive analytics administration');
const transport=collaboration.split('function analyticsTransport()')[1]?.split('function shareInfo()')[0]??'';
assert.doesNotMatch(transport,/credentials\(|publicId|token/,'site analytics ingestion must not depend on a shared-project capability');
assert.match(transport,/index \+= 50/,'event uploads must be chunked to the backend batch limit');
assert.match(transport,/index \+= 200/,'heatmap uploads must be chunked to the backend batch limit');
const setup=customerApp.split('function setupAnalytics()')[1]?.split('function analyticsRegion')[0]??'';
assert.doesNotMatch(setup,/shareInfo|active\(\)|projectId/,'collection must cover the site rather than only shared projects');
assert.match(customerApp,/usageConsent/,'customers must receive a consent choice without analytics administration');
assert.ok(customerApp.indexOf('timestamp-lastPointerAnalytics<100')<customerApp.indexOf("analyticsRegion(event.target),rect"),'pointer sampling must throttle before layout measurement');

assert.match(adminHtml,/name=["']robots["'] content=["']noindex,nofollow,noarchive["']/,'private desk should be excluded from search indexing');
assert.match(adminHtml,/id=["']adminKey["'][^>]+type=["']password["']/,'private desk requires a hidden admin-key input');
assert.match(adminJs,/adminKey,paginationOpts/,'raw analytics queries must use the separate admin key');
assert.match(adminJs,/api\(\)\.clear,\{adminKey\}/,'analytics deletion must use the separate admin key');
assert.doesNotMatch(adminJs,/(?:localStorage|sessionStorage)\.setItem\([^\n]*adminKey/i,'the analytics admin key must never be persisted by the browser');
assert.doesNotMatch(adminJs,/projectId|ownerAccess|editorToken|viewerToken/,'the private desk must not accept shared-project capabilities');
assert.doesNotMatch(adminJs,/setInterval|onUpdate/,'the raw-data desk must not poll or subscribe continuously');

const pageSize=Number(adminJs.match(/const PAGE_SIZE=(\d+)/)?.[1]);
const exportPageSize=Number(adminJs.match(/const EXPORT_PAGE_SIZE=(\d+)/)?.[1]);
assert.ok(pageSize>0&&pageSize<=100,'desk pages must keep DOM rendering bounded to 100 rows');
assert.ok(exportPageSize>0&&exportPageSize<=500,'export pagination must stay inside the backend limit');

console.log('Analytics admin access contract passed.');
