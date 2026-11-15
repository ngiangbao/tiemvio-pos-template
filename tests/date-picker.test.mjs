import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../web/src/ui.js',import.meta.url),'utf8');
function setup(){
 const nodes={day:{value:'15-11-2026'},dayPick:{value:'2026-11-15'}};
 const context=vm.createContext({document:{getElementById:id=>nodes[id]}});
 const dates=source.slice(source.indexOf('const dmy='),source.indexOf('const dateParts='));
 const controls=source.slice(source.indexOf('const dateField='),source.indexOf('const SIZE_LIST='));
 vm.runInContext("const $=id=>document.getElementById(id);"+dates+controls+';globalThis.bind=wireDate;globalThis.markup=dateField;',context);
 return {nodes,context};
}
test('native date input is an accessible touch target without synthetic picker APIs',()=>{
 const {context}=setup();const markup=context.markup('day','2026-11-15');
 assert.match(markup,/class="date-trigger"/);assert.match(markup,/type="date"/);assert.doesNotMatch(markup,/aria-hidden="true"[^>]*type="date"|tabindex="-1"/);
 const css=readFileSync(new URL('../web/index.html',import.meta.url),'utf8');assert.match(css,/pointer-events: auto/);
});
test('touch and keyboard focus sync the current typed/report shortcut date without showPicker',()=>{
 const {nodes,context}=setup();context.bind('day');
 nodes.day.value='01-12-2026';nodes.dayPick.onpointerdown();assert.equal(nodes.dayPick.value,'2026-12-01');
 nodes.day.value='02-12-2026';nodes.dayPick.onfocus();assert.equal(nodes.dayPick.value,'2026-12-02');
});
test('native picker change updates dd-mm-yyyy and applies the selected day once; cancel does nothing',()=>{
 const {nodes,context}=setup();const selected=[];context.bind('day',iso=>selected.push(iso));
 nodes.dayPick.value='2026-12-25';nodes.dayPick.onchange();assert.equal(nodes.day.value,'25-12-2026');assert.deepEqual(selected,['2026-12-25']);
 nodes.dayPick.value='';nodes.dayPick.onchange();assert.equal(selected.length,1);
});
test('manual date entry still formats and rejects impossible dates',()=>{
 const {nodes,context}=setup();const selected=[];context.bind('day',iso=>selected.push(iso));
 nodes.day.value='25122026';nodes.day.oninput();assert.equal(nodes.day.value,'25-12-2026');assert.equal(selected[0],'2026-12-25');
 nodes.day.value='31022026';nodes.day.oninput();assert.equal(selected.length,1);
});
