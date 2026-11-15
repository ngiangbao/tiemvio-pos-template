const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {makeFeed}=require('../scripts/create-update-feed.cjs');
test('feed is signed with pinned key and rejects a different signing key',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tiemvio-feed-'));
 try {
  fs.writeFileSync(path.join(dir,'Tiemvio-POS-Windows.exe'),'test-exe');fs.writeFileSync(path.join(dir,'Tiemvio-POS-Android.apk'),'test-apk');
  const bad=crypto.generateKeyPairSync('rsa',{modulusLength:2048});
  assert.throws(()=>makeFeed(dir,bad.privateKey),/does not match|unsupported|decoder|PEM|key/i);
  assert.equal(fs.existsSync(path.join(dir,'native-update.json')),false);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
