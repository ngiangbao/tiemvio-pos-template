const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');const root=path.join(__dirname,'..');
const files=[];function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){if(['.git','node_modules','dist','secrets','bin','obj','publish','build','.gradle'].includes(e.name))continue;const p=path.join(dir,e.name);if(e.isDirectory())walk(p);else files.push(p);}}walk(root);
for(const p of files){assert.ok(!/\.(jks|keystore|log|apk|exe|zip)$/.test(p),'Unexpected data/artifact: '+p);if(!/\.(png|ico)$/.test(p)){const s=fs.readFileSync(p,'utf8');assert.ok(!/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(s),'Private key: '+p);}}
if(!fs.existsSync(path.join(root,'shop.configured.json'))){
 const config=fs.readFileSync(path.join(root,'web/src/firebase-config.js'),'utf8');assert.ok(config.includes('YOUR_FIREBASE_API_KEY'));
 assert.equal(fs.readFileSync(path.join(root,'apps/update-public.pem'),'utf8').trim(),'');
 assert.match(fs.readFileSync(path.join(root,'web/src/backend.js'),'utf8'),/DEFAULT_MENU = \[\]/);
 assert.ok(!fs.existsSync(path.join(root,'web/public/.well-known/assetlinks.json')));
}
console.log('Template baseline checked: no private keys, signing identity, logs, installers or seeded business data.');
