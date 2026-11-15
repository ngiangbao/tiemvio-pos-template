const fs=require('node:fs'),path=require('node:path');const root=path.join(__dirname,'..');
if(!fs.existsSync(path.join(root,'shop.configured.json')))throw Error('Run npm run configure:shop for this clone first.');
const c=JSON.parse(fs.readFileSync(path.join(root,'shop.configured.json')));
if(!c.appUrl.startsWith('https://')||c.appUrl.includes('.invalid'))throw Error('Invalid app origin');
if(process.argv.includes('--native')&&!fs.readFileSync(path.join(root,'apps/update-public.pem'),'utf8').includes('BEGIN PUBLIC KEY'))throw Error('Run npm run native:init to generate a NEW signing identity before publishing installers.');
console.log('Configuration ready for '+c.name);
