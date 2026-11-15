// Generate fresh keys locally for EACH shop. The template never contains a signing identity.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process');
const root=path.join(__dirname,'..');require('./check-configured.cjs');
if(cp.spawnSync('keytool',['-help'],{windowsHide:true,stdio:'ignore'}).status!==0)throw Error('Install JDK 17+ and put keytool on PATH before generating keys.');
const dir=path.join(root,'secrets');fs.mkdirSync(dir,{recursive:true});
const keyPath=path.join(dir,'update-private.pem');if(fs.existsSync(keyPath))throw Error('Signing keys already exist. Keep them stable for installed users.');
const keys=crypto.generateKeyPairSync('rsa',{modulusLength:3072,publicKeyEncoding:{format:'pem',type:'spki'},privateKeyEncoding:{format:'pem',type:'pkcs8'}});
fs.writeFileSync(keyPath,keys.privateKey,{mode:0o600});fs.writeFileSync(path.join(root,'apps/update-public.pem'),keys.publicKey);
const password=crypto.randomBytes(32).toString('base64url');fs.writeFileSync(path.join(dir,'android-password.txt'),password,{mode:0o600});
const jks=path.join(dir,'release.jks');const alias='pos-release';
const result=cp.spawnSync('keytool',['-genkeypair','-keystore',jks,'-storetype','PKCS12','-alias',alias,'-keyalg','RSA','-keysize','3072','-validity','10000','-dname','CN=POS App, O=Shop App, C=VN','-storepass',password,'-keypass',password],{encoding:'utf8',windowsHide:true});
if(result.status!==0)throw Error('keytool failed. Install a JDK and resolve the error before retrying: '+result.stderr);
const cert=cp.execFileSync('keytool',['-exportcert','-rfc','-keystore',jks,'-alias',alias,'-storepass',password],{encoding:'utf8',windowsHide:true});
const fingerprint=new crypto.X509Certificate(cert).fingerprint256;
const c=JSON.parse(fs.readFileSync(path.join(root,'shop.configured.json')));
fs.mkdirSync(path.join(root,'web/public/.well-known'),{recursive:true});
fs.writeFileSync(path.join(root,'web/public/.well-known/assetlinks.json'),JSON.stringify([{relation:['delegate_permission/common.handle_all_urls'],target:{namespace:'android_app',package_name:c.androidPackage,sha256_cert_fingerprints:[fingerprint]}}],null,2)+'\n');
fs.writeFileSync(path.join(dir,'keystore-base64.txt'),fs.readFileSync(jks).toString('base64'),{mode:0o600});
console.log('Created keys in ignored secrets/. Back them up securely. Upload via GitHub Secrets, never commit them. Android alias: '+alias);
