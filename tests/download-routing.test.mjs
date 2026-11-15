import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {appDownloads} from '../web/src/app-downloads.js';
test('iOS downloads stay outside the POS navigation fallback and use a separate static origin',()=>{
 const source=fs.readFileSync(new URL('../web/vite.config.mjs',import.meta.url),'utf8');
 const expression=source.match(/navigateFallbackDenylist:\s*(\[[^\n]+\])/)[1];const deny=Function('return '+expression)();
 for(const p of ['/example.mobileconfig','/example.mobileconfig?download=1','/install-ios.html','/install-ios.html?v=2','/legal.txt','/__/auth/handler'])assert.equal(deny.some(r=>r.test(p)),true,p);
 assert.equal(deny.some(r=>r.test('/')),false);
 const marker=new URL('../shop.configured.json',import.meta.url);const url=fs.existsSync(marker)?'https://'+JSON.parse(fs.readFileSync(marker)).downloadsSite+'.web.app':'https://DOWNLOADS_HOST.invalid';
 assert.ok(appDownloads().includes(url+'/install-ios.html'));
 const config=JSON.parse(fs.readFileSync(new URL('../firebase.json',import.meta.url)));
 const site=config.hosting.find(s=>s.public==='downloads');assert.ok(site);assert.equal(site.rewrites,undefined);
});
