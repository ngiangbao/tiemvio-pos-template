// Each clone gets its own Firebase project, origin, release repository and Android application ID.
const fs=require('node:fs'),path=require('node:path');
const root=path.join(__dirname,'..');
const config=JSON.parse(fs.readFileSync(path.join(root,process.argv[2]||'shop.config.json'),'utf8'));
const ok=(value,re,label)=>{if(typeof value!=='string'||!re.test(value))throw Error('Invalid '+label);};
ok(config.name,/^[\p{L}\p{N} ._-]{2,60}$/u,'shop name');
ok(config.slug,/^[a-z][a-z0-9-]{2,35}$/,'slug');
ok(config.ownerEmail,/^[a-zA-Z0-9_.+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/,'owner email');
if(config.ownerEmail.endsWith('.invalid'))throw Error('Supply the real owner Google address');
ok(config.supportEmail,/^[a-zA-Z0-9_.+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/,'support contact');
ok(config.firebase.projectId,/^[a-z][a-z0-9-]{5,29}$/,'Firebase project');
ok(config.firebase.apiKey,/^[A-Za-z0-9_-]{20,100}$/,'Firebase public API key');
ok(config.firebase.appId,/^[A-Za-z0-9:_-]{8,150}$/,'Firebase app ID');
ok(config.firebase.authDomain,/^[a-zA-Z0-9.-]+$/,'Firebase auth domain');
ok(config.releasesRepo,/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/,'release repository');
ok(config.downloadsSite,/^[a-z0-9][a-z0-9-]{4,28}[a-z0-9]$/,'separate Firebase download site ID');
ok(config.androidPackage,/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){2,}$/,'Android package');
const url=new URL(config.appUrl);if(url.protocol!=='https:'||url.hostname.endsWith('.invalid')||url.origin!==config.appUrl)throw Error('Use a real HTTPS origin without trailing slash');
if(config.firebase.authDomain!==url.hostname)throw Error('Use the app hostname as Firebase authDomain and configure Firebase Auth accordingly');
const marker=path.join(root,'shop.configured.json');
if(fs.existsSync(marker))throw Error('This clone is already configured. Start a new clone for another shop to avoid mixing identities.');
const replacements=new Map([
 ['https://APP_HOST.invalid',config.appUrl],['YOUR_GITHUB_OWNER/RELEASES_REPO',config.releasesRepo],
 ['https://DOWNLOADS_HOST.invalid','https://'+config.downloadsSite+'.web.app'],['DOWNLOADS_SITE_ID',config.downloadsSite],
 ['YOUR_FIREBASE_PROJECT_ID',config.firebase.projectId],['owner@example.invalid',config.ownerEmail.toLowerCase()],
 ['support@example.invalid',config.supportEmail],['Tiemvio POS',config.name],['app.tiemviopos.template',config.androidPackage]
 ,['TiemvioPOS','POS_'+config.slug.replace(/-/g,'_')],['Tiemvio-POS',config.slug]
]);
function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){if(['.git','node_modules','dist','bin','obj','publish','.gradle','build'].includes(e.name))continue;const p=path.join(dir,e.name);if(e.isDirectory())walk(p);else if(/\.(js|mjs|cjs|json|html|md|txt|toml|rules|xml|java|gradle|cs|csproj|nsi|yml|svg)$/.test(e.name)&&p!==__filename&&!['check-template.cjs','check-configured.cjs','init-native.cjs','shop.config.example.json','shop.config.json'].includes(e.name)){let s=fs.readFileSync(p,'utf8');for(const [from,to]of replacements)s=s.replaceAll(from,to);fs.writeFileSync(p,s);}}}
walk(root);
fs.renameSync(path.join(root,'apps/windows/TiemvioPOS.csproj'),path.join(root,'apps/windows/POS_'+config.slug.replace(/-/g,'_')+'.csproj'));
fs.writeFileSync(path.join(root,'web/src/firebase-config.js'),'// Public Firebase identifiers for this shop. Never add admin credentials here.\nexport const firebaseConfig='+JSON.stringify(config.firebase,null,2)+';\n');
fs.writeFileSync(path.join(root,'.firebaserc'),JSON.stringify({projects:{default:config.firebase.projectId}},null,2)+'\n');
fs.writeFileSync(marker,JSON.stringify({name:config.name,slug:config.slug,appUrl:config.appUrl,downloadsSite:config.downloadsSite,releasesRepo:config.releasesRepo,androidPackage:config.androidPackage,firebaseProject:config.firebase.projectId},null,2)+'\n');
console.log('Configured '+config.name+'. Create the NEW empty Firestore database and deploy its rules before signing in.');
