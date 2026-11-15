const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
test('iOS profile only installs a removable HTTPS Web Clip with the app icon',()=>{
 cp.execFileSync(process.execPath,[path.join(__dirname,'../scripts/generate-ios.cjs')]);
 const file=fs.readFileSync(path.join(__dirname,'../web/public/Tiemvio-POS-iOS.mobileconfig'),'utf8');
 assert.equal((file.match(/<key>PayloadType<\/key>/g)||[]).length,2);
 assert.match(file,/<string>Configuration<\/string>/);assert.match(file,/<string>com.apple.webClip.managed<\/string>/);
 assert.match(file,/<key>IsRemovable<\/key><true\/>/);assert.match(file,/<key>PayloadRemovalDisallowed<\/key><false\/>/);
 const marker=path.join(__dirname,'../shop.configured.json');const expectedUrl=fs.existsSync(marker)?JSON.parse(fs.readFileSync(marker)).appUrl+'/':'https://APP_HOST.invalid/';
 assert.ok(file.includes('<key>URL</key><string>'+expectedUrl+'</string>'));
 assert.doesNotMatch(file,/<string>com\.apple\.(mdm|vpn|security|wifi)/i);
 const icon=Buffer.from(file.match(/<data>([^<]+)<\/data>/)[1],'base64');assert.equal(icon.subarray(1,4).toString(),'PNG');
 assert.equal(new Set([...file.matchAll(/<key>PayloadUUID<\/key><string>([^<]+)/g)].map(m=>m[1])).size,2);
});
