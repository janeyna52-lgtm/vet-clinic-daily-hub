import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalInvoice, priceCatalog } from '../priceCatalog.js';
import { validateCarePlan } from '../careWorkflow.js';
test('catalog rejects price tampering, unknown items, renamed products and fractional quantities', () => {
 const item = priceCatalog()[0]; const line = {catalogId:item.id, name:item.name, price:item.price,qty:2};
 assert.equal(canonicalInvoice([line])[0].price,500);
 for(const patch of [{price:1},{catalogId:'fake'},{name:'Fake'},{qty:0.5},{qty:0}]) assert.equal(canonicalInvoice([{...line,...patch}]),null);
 assert.equal(canonicalInvoice([]),null);
});
test('configured products use fixed prices; invalid deployment configuration fails closed', () => {
 const old=process.env.CLINIC_PRODUCTS_JSON;
 try {
  process.env.CLINIC_PRODUCTS_JSON=JSON.stringify([{id:'product_shampoo',name:'Synthetic shampoo',category:'Pet shampoo',price:125}]);
  const product=priceCatalog().find(p=>p.id==='product_shampoo');
  assert.equal(canonicalInvoice([{...product,catalogId:product.id,qty:3}])[0].price,125);
  process.env.CLINIC_PRODUCTS_JSON=JSON.stringify([{...product,price:-1}]);assert.throws(()=>priceCatalog());
 } finally { if(old===undefined) delete process.env.CLINIC_PRODUCTS_JSON; else process.env.CLINIC_PRODUCTS_JSON=old; }
});
test('follow-up requires real dates, a supported status and clinical instructions', () => {
 assert.equal(validateCarePlan({},'2026-10-24'),null);
 const plan={careStatus:'Recheck required',followUpDate:'2026-10-27',followUpReason:'Assess healing'};
 assert.equal(validateCarePlan(plan,'2026-10-24'),null);
 for(const patch of [{careStatus:'Unknown'},{followUpDate:'2026-02-30'},{followUpDate:'2026-10-23'},{followUpReason:''}]) assert.ok(validateCarePlan({...plan,...patch},'2026-10-24'));
});
