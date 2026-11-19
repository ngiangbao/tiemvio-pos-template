import test from 'node:test';
import assert from 'node:assert/strict';
import {clockIso, clockLocal, clockWarning} from '../web/src/timeclock.js';
test('owner clock-out time uses shop timezone including midnight, invalid dates and DST gaps',()=>{
  assert.equal(clockIso('2026-11-18','17:00'),'2026-11-18T10:00:00.000Z');
  assert.deepEqual(clockLocal('2026-11-18T18:00:00.000Z'),{day:'2026-11-19',time:'01:00'});
  assert.throws(()=>clockIso('2026-02-30','17:00'));assert.throws(()=>clockIso('2026-11-19','25:00'));
  assert.equal(clockIso('2026-11-19','09:00','Australia/Sydney'),'2026-11-18T22:00:00.000Z');
  assert.throws(()=>clockIso('2026-10-04','02:30','Australia/Sydney'));
});
test('warnings flag previous days, overdue matching plans and long unscheduled work without closing entries',()=>{
  const entry={email:'staff@example.com',inAt:clockIso('2026-11-19','07:00'),outAt:''};
  const plan=[{email:entry.email,day:'2026-11-19',start:'07:00',end:'12:00'},{email:entry.email,day:'2026-11-19',start:'17:00',end:'22:00'}];
  assert.equal(clockWarning(entry,plan,Date.parse(clockIso('2026-11-19','12:10'))),'');
  assert.match(clockWarning(entry,plan,Date.parse(clockIso('2026-11-19','12:16'))),/15 phút/);
  assert.match(clockWarning(entry,[],Date.parse(clockIso('2026-11-19','19:00'))),/12 giờ/);
  assert.match(clockWarning(entry,[],Date.parse(clockIso('2026-11-20','01:00'))),/ngày trước/);
  assert.equal(clockWarning({...entry,outAt:clockIso('2026-11-19','12:00')},plan,Date.parse(clockIso('2026-11-20','01:00'))),'');
  assert.equal(entry.outAt,'');
});
