/* ทดสอบ supabase/schema.sql บน Postgres จำลอง (PGlite)  รัน: npm run test:db */
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const sql = fs.readFileSync(path.join(here, '..', 'supabase', 'schema.sql'), 'utf8');
const db = new PGlite();
let pass=0, fail=0;
const ok=(c,m)=>{ if(c){pass++;console.log('PASS',m)}else{fail++;console.log('FAIL',m)} };
await db.exec(`create role anon nologin; create role authenticated nologin; grant usage on schema public to anon, authenticated;`);
await db.exec(sql);            // no publication -> undefined_object branch
await db.exec(sql);            // idempotent re-run
ok(true,'schema runs twice without error');

await db.exec(`insert into public.docs(collection,id,data) values
 ('units','R9NXCV12345678A','{"serial":"R9NXCV12345678A","product":"ASUS TUF","brand":"ASUS","category":"โน้ตบุ๊ก","status":"sold","customer":"คุณสมชาย","phone":"081","invoice":"INV-1","supplier":"SYN","warrantyMonths":36,"warrantyEnd":"2029-03-14"}'),
 ('units','STOCK0001','{"serial":"STOCK0001","product":"MSI","status":"in_stock","warrantyMonths":24}');`);

async function asRole(role, hdr, q){
  await db.exec(`set role ${role}`);
  if(hdr!==null) await db.query(`select set_config('request.headers',$1,false)`,[hdr]);
  try { return await db.query(q); } finally { await db.exec('reset role'); }
}
let r = await asRole('anon', JSON.stringify({'x-forwarded-for':'1.2.3.4, 10.0.0.1'}), `select public.check_warranty(' r9nx cv12345678a ') as r`);
let j = r.rows[0].r;
ok(j.ok && j.found && j.sold && j.warrantyEnd==='2029-03-14', 'anon finds sold unit (lowercase + spaces normalised)');
ok(!('customer' in j) && !('phone' in j) && !('invoice' in j) && !('supplier' in j), 'public result hides customer, phone, invoice, supplier');
r = await asRole('anon', null, `select public.check_warranty('STOCK0001') as r`); j=r.rows[0].r;
ok(j.found && j.sold===false, 'in-stock unit reported as not sold');
r = await asRole('anon', null, `select public.check_warranty('NOPE-NOT-HERE') as r`); j=r.rows[0].r;
ok(j.ok && j.found===false, 'unknown serial -> found:false');
r = await asRole('anon', null, `select public.check_warranty('ab') as r`); j=r.rows[0].r;
ok(j.ok===false && j.error==='invalid', 'too-short serial -> invalid');

let blocked=false; try{ await asRole('anon',null,`select * from public.docs`);}catch(e){blocked=true}
ok(blocked,'anon cannot read docs directly');
blocked=false; try{ await asRole('anon',null,`insert into public.docs(collection,id) values('units','x')`);}catch(e){blocked=true}
ok(blocked,'anon cannot write docs');
blocked=false; try{ await asRole('anon',null,`select * from public.check_log`);}catch(e){blocked=true}
ok(blocked,'anon cannot read check_log');
r = await asRole('authenticated',null,`select count(*)::int c from public.docs`);
ok(r.rows[0].c===2,'authenticated staff can read docs');
await asRole('authenticated',null,`update public.docs set data=data||'{"customer":"X"}' where id='STOCK0001'`);
r = await db.query(`select updated_at > now() - interval '1 minute' as fresh from public.docs where id='STOCK0001'`);
ok(r.rows[0].fresh,'update trigger sets updated_at');

// rate limit: IP 9.9.9.9 gets 30 calls, 31st blocked, other IP unaffected
const h = JSON.stringify({'x-forwarded-for':'9.9.9.9'});
let lastOk=0, limited=false;
for(let i=0;i<32;i++){
  const x=(await asRole('anon',h,`select public.check_warranty('STOCK0001') as r`)).rows[0].r;
  if(x.ok) lastOk++; else if(x.error==='rate_limited'){limited=true;break}
}
ok(limited && lastOk===30,'31st call from same IP is rate_limited (ok calls: '+lastOk+')');
const o=(await asRole('anon',JSON.stringify({'x-forwarded-for':'8.8.8.8'}),`select public.check_warranty('STOCK0001') as r`)).rows[0].r;
ok(o.ok,'different IP not affected');

// publication branch present
await db.exec(`create publication supabase_realtime; `);
await db.exec(sql);
r = await db.query(`select count(*)::int c from pg_publication_tables where pubname='supabase_realtime' and tablename='docs'`);
ok(r.rows[0].c===1,'table added to realtime publication when it exists');
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail?1:0);
