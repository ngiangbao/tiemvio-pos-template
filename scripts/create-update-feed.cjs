const fs=require('node:fs');const crypto=require('node:crypto');const path=require('node:path');
const {version}=require('../package.json');
function makeFeed(dir,key){
 const base=`https://github.com/YOUR_GITHUB_OWNER/RELEASES_REPO/releases/download/v${version}/`;
 const hash=name=>crypto.createHash('sha256').update(fs.readFileSync(path.join(dir,name))).digest('hex');
 const [major,minor,patch]=version.split('.').map(Number);
 const feed={schema:1,version,windows:{url:base+'Tiemvio-POS-Windows.exe',sha256:hash('Tiemvio-POS-Windows.exe')},android:{url:base+'Tiemvio-POS-Android.apk',sha256:hash('Tiemvio-POS-Android.apk'),versionCode:major*1000000+minor*1000+patch}};
 const bytes=Buffer.from(JSON.stringify(feed,null,2)+'\n');
 const sig=crypto.sign('RSA-SHA256',bytes,key).toString('base64');
 const pub=fs.readFileSync(path.join(__dirname,'../apps/update-public.pem'));
 if(!crypto.verify('RSA-SHA256',bytes,pub,Buffer.from(sig,'base64')))throw Error('Signing key does not match installed app public key');
 fs.writeFileSync(path.join(dir,'native-update.json'),bytes);fs.writeFileSync(path.join(dir,'native-update.sig'),sig+'\n');
 fs.writeFileSync(path.join(dir,'SHA256SUMS.txt'),Object.entries(feed).filter(([k])=>['windows','android'].includes(k)).map(([,v])=>v.sha256+'  '+v.url.split('/').pop()).join('\n')+'\n');
 return feed;
}
module.exports={makeFeed};
if(require.main===module)makeFeed(process.argv[2]||'release',process.env.UPDATE_SIGNING_PRIVATE_KEY);
