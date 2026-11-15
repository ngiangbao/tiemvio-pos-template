import {test} from 'node:test';
import assert from 'node:assert/strict';
import {canApplyUpdate} from '../web/src/update-policy.js';
import {appDownloads} from '../web/src/app-downloads.js';
test('automatic updates wait for transactions, forms, editing, uncertain writes and AI',()=>{
 const clean={cart:[],ai:{}};
 assert.equal(canApplyUpdate(clean),true);
 for(const state of [{busy:true},{syncing:true},{editing:{}},{pending:{}},{mutationRetry:{}},{cart:[{}]},{ai:{busy:true}},{ai:{pending:{}}},{ai:{unsaved:{}}},{ai:{draft:'chưa gửi'}}])assert.equal(canApplyUpdate({...clean,...state}),false,JSON.stringify(state));
 assert.equal(canApplyUpdate(clean,true),false);
 assert.match(appDownloads(),/latest\/download\/Tiemvio-POS-Windows\.exe/);
 assert.match(appDownloads(),/latest\/download\/Tiemvio-POS-Android\.apk/);
});
