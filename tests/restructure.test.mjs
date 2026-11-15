import test from 'node:test';
import assert from 'node:assert/strict';
import {allocate,splitHistorical,mergeHistorical} from '../web/src/restructure.js';
const sample=()=>({items:[{productId:'tea',quantity:3,lineTotal:10000,unitPrice:10000,packQty:3}],total:7000,cogs:7,audit:[{phone:'',subtotal:10000,redeemed:1,discount:1000,promoDiscount:1500,manualDiscount:500,stockUsage:{tea:1.01}}]});
const usage=items=>({tea:items.reduce((n,x)=>n+x.quantity,0)});
test('allocation preserves integers and capacities, including zero weights',()=>{
  for(let n=0;n<100;n++)for(const weights of [[1,1,1],[0,0,0],[1,10,100]]){
    const parts=allocate(n,weights);assert.equal(parts.reduce((a,b)=>a+b,0),n);assert.ok(parts.every(Number.isSafeInteger));
  }
  assert.deepEqual(allocate(9,[100,1],[2,7]),[2,7]);assert.throws(()=>allocate(10,[1,1],[4,5]));
});
test('split preserves pack rounding, money, discounts, points and stock to 0.01 units',()=>{
  const source=sample(),parts=splitHistorical(source,[[{line:0,quantity:1}],[{line:0,quantity:1}],[{line:0,quantity:1}]],usage);
  assert.equal(parts.reduce((n,x)=>n+x.items[0].lineTotal,0),10000);
  assert.equal(parts.reduce((n,x)=>n+x.total,0),source.total);
  assert.equal(parts.reduce((n,x)=>n+x.first.redeemed,0),1);
  assert.equal(Math.round(parts.reduce((n,x)=>n+(x.first.stockUsage.tea||0),0)*100),101);
  const merged=mergeHistorical(parts.map(x=>({...x,audit:[x.first]})),usage);
  assert.equal(merged.total,source.total);assert.equal(merged.cogs,source.cogs);assert.equal(merged.first.stockUsage.tea,1.01);
});
test('split rejects omitted, duplicate, fractional and excess quantities and empty groups',()=>{
  for(const groups of [[[],[{line:0,quantity:3}]],[[{line:0,quantity:1}],[{line:0,quantity:1}]],[[{line:0,quantity:1.5}],[{line:0,quantity:1.5}]],[[{line:0,quantity:2}],[{line:0,quantity:2}]],[[{line:0,quantity:1},{line:0,quantity:1}],[{line:0,quantity:1}]]])assert.throws(()=>splitHistorical(sample(),groups,usage));
});
test('merge rejects different loyalty customers',()=>{const a=sample(),b=sample();b.audit[0].phone='0901234567';assert.throws(()=>mergeHistorical([a,b],usage),/số điện thoại/)});

test('split and merge retain historical custom point value and redemption limit',()=>{
  const source=sample();Object.assign(source.audit[0],{redeemed:4,discount:8000,loyaltyPointValue:2000,loyaltyMaxRedeemShare:1,promoDiscount:0,manualDiscount:0});source.total=2000;
  const parts=splitHistorical(source,[[{line:0,quantity:1}],[{line:0,quantity:2}]],usage);
  assert.equal(parts.reduce((n,p)=>n+p.first.discount,0),8000);assert.equal(parts.reduce((n,p)=>n+p.first.redeemed,0),4);
  const merged=mergeHistorical(parts.map(p=>({...p,audit:[p.first]})),usage);
  assert.equal(merged.total,2000);assert.equal(merged.first.loyaltyPointValue,2000);assert.equal(merged.first.loyaltyMaxRedeemShare,1);
  const old=sample();assert.throws(()=>mergeHistorical([source,old],usage),/giá trị khác nhau/);
});
