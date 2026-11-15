const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const code=fs.readFileSync(require('node:path').join(__dirname,'../web/public/app-display.js'),'utf8');
function boot(appleStandalone,display){
  const classes=new Set(),queries=[],events={};
  const context={navigator:{standalone:appleStandalone},document:{documentElement:{classList:{toggle(name,on){on?classes.add(name):classes.delete(name);}}}},
    matchMedia(text){const q={matches:text===`(display-mode: ${display})`,addEventListener(type,fn){this.change=fn;}};queries.push(q);return q;},
    addEventListener(type,fn){events[type]=fn;}};
  vm.runInNewContext(code,context);
  return {classes,queries,events,context};
}
test('profile Web Clip uses Apple standalone fallback even when CSS mode reports browser',()=>{
  assert(boot(true,'browser').classes.has('app-display'));
});
test('Home Screen PWA and Android fullscreen both use installed layout; browser stays unchanged',()=>{
  for(const mode of ['standalone','fullscreen'])assert(boot(undefined,mode).classes.has('app-display'));
  assert(!boot(false,'browser').classes.has('app-display'));
});
test('display mode changes and return from background refresh installed layout',()=>{
  const app=boot(false,'browser');app.queries[1].matches=true;app.queries[1].change();
  assert(app.classes.has('app-display'));
  app.queries[1].matches=false;app.events.pageshow();assert(!app.classes.has('app-display'));
});
