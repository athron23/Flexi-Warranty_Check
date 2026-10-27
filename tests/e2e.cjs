/* ทดสอบหน้าเว็บด้วย Playwright (Chromium)
 * รัน: node tests/e2e.cjs   (ต้องมี playwright ติดตั้งอยู่)
 * ส่วนที่ 1 ทดสอบโหมดทดลอง ส่วนที่ 2 ทดสอบโหมด Supabase ด้วยตัวจำลองเซิร์ฟเวอร์ในไฟล์นี้
 * (ไม่ได้ต่อ Supabase จริง) */
const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require('playwright');
const DOCS = path.join(__dirname, '..', 'docs');
const OUT = process.env.SHOT_DIR || '';
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html';
  const f = path.join(DOCS, p);
  if (!f.startsWith(DOCS) || !fs.existsSync(f)) { res.writeHead(404); return res.end('nf'); }
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); res.end(fs.readFileSync(f));
});
let pass = 0, fail = 0;
const T = (name, cond, extra) => { if (cond) { pass++; console.log('PASS', name); } else { fail++; console.log('FAIL', name, extra === undefined ? '' : JSON.stringify(extra)); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const FAKE_SUPABASE = `
(function(){
  var listeners = [], rpcCalls = 0, session = null;
  try { if (sessionStorage.getItem('fake.sess')) session = { email: 'staff@flexi.test' }; } catch (e) {}
  function load(){ try { return new Map(JSON.parse(localStorage.getItem('fake.db') || '[]')); } catch (e) { return new Map(); } }
  function save(m){ localStorage.setItem('fake.db', JSON.stringify(Array.from(m.entries()))); }
  window.__fake = { get rows(){ return load(); }, rpcCalls: function(){ return rpcCalls; } };
  function key(c,i){ return c+'|'+i }
  function thenable(fn){ var o = { then:function(a,b){ return Promise.resolve().then(fn).then(a,b) } }; return o }
  function fire(type, row){ listeners.forEach(function(l){ l(type==='DELETE'?{eventType:type,old:{collection:row.collection,id:row.id}}:{eventType:type,new:row}) }) }
  function createClient(url,keyv){
    return {
      from:function(t){ return {
        select:function(){ var f=[],single=false,rng=null; var b={eq:function(c,v){f.push([c,v]);return b},order:function(){return b},range:function(a,z){rng=[a,z];return b},maybeSingle:function(){single=true;return b},
          then:function(a,c){ return Promise.resolve().then(function(){
            if(!session) return {data:null,error:{code:'42501',message:'permission denied'}};
            var out=[]; load().forEach(function(r){ if(f.every(function(x){return r[x[0]]===x[1]})) out.push({id:r.id,data:r.data}) });
            out.sort(function(x,y){return x.id<y.id?-1:1});
            if(rng) out=out.slice(rng[0],rng[1]+1);
            return single?{data:out[0]||null,error:null}:{data:out,error:null};
          }).then(a,c) } }; return b },
        upsert:function(row){ return thenable(function(){ if(!session) return {error:{code:'42501',message:'rls'}}; var m=load(); var ex=m.has(key(row.collection,row.id)); var r={collection:row.collection,id:row.id,data:JSON.parse(JSON.stringify(row.data))}; m.set(key(row.collection,row.id),r); save(m); fire(ex?'UPDATE':'INSERT',r); return {error:null} }) },
        delete:function(){ var f=[]; var b={eq:function(c,v){f.push([c,v]);return b},then:function(a,c){ return Promise.resolve().then(function(){ if(!session) return {error:{code:'42501',message:'rls'}}; var m=load(); m.forEach(function(r,k){ if(f.every(function(x){return r[x[0]]===x[1]})){ m.delete(k); fire('DELETE',r) } }); save(m); return {error:null} }).then(a,c) } }; return b }
      } },
      channel:function(){ var ch={ on:function(t,flt,cb){ listeners.push(cb); return ch }, subscribe:function(){ return ch } }; return ch },
      removeChannel:function(){},
      rpc:function(name,args){ return thenable(function(){ rpcCalls++;
        var s=String(args.p_serial||'').replace(/\\s+/g,'').toUpperCase(); if(s.length<4) return {data:{ok:false,error:'invalid'},error:null};
        var hit=null; load().forEach(function(r){ if(r.collection==='units'&&r.data.serial===s) hit=r.data });
        if(!hit) return {data:{ok:true,found:false},error:null};
        return {data:{ok:true,found:true,serial:hit.serial,product:hit.product,brand:hit.brand,category:hit.category,sold:hit.status==='sold',warrantyMonths:hit.warrantyMonths,warrantyEnd:hit.warrantyEnd||null,today:new Date().toISOString().slice(0,10)},error:null} }) },
      auth:{
        getSession:function(){ return Promise.resolve({data:{session:session?{user:session}:null}}) },
        signInWithPassword:function(c){ return Promise.resolve().then(function(){ if(c.email==='staff@flexi.test'&&c.password==='goodpass1'){ session={email:c.email}; try{sessionStorage.setItem('fake.sess','1')}catch(e){} return {data:{user:session},error:null} } return {data:null,error:{message:'Invalid login credentials'}} }) },
        signOut:function(){ session=null; try{sessionStorage.removeItem('fake.sess')}catch(e){} return Promise.resolve({error:null}) }
      }
    };
  }
  window.supabase = { createClient: createClient };
})();`;

(async () => {
  await new Promise(r => server.listen(0, r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });

  async function newPage(ctx, errors) {
    const page = await ctx.newPage();
    page.on('pageerror', e => { if (!/play\(\) request was interrupted/.test(e.message)) errors.push('pageerror: ' + e.message); });
    page.on('console', m => { if (m.type() === 'error' && !/fonts\.g|ERR_|Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });
    await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
    return page;
  }
  const scan = async (page, sel, text) => { await page.focus(sel); await page.keyboard.type(text + '\n', { delay: 4 }); };

  /* ===================== ส่วนที่ 1: โหมดทดลอง ===================== */
  {
    const errors = [];
    const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 }, acceptDownloads: true, permissions: ['camera'] });
    const page = await newPage(ctx, errors);
    await page.goto(base + '/index.html');
    await page.waitForFunction(() => document.querySelector('#n-sold') && document.querySelector('#n-sold').textContent !== '0');
    T('demo: app visible without login, login hidden', await page.isVisible('#app') && !(await page.isVisible('#login')));
    T('demo: demo banner shown', await page.isVisible('#demo-note'));
    T('demo: status text says demo, not shared/online', (await page.textContent('#status')).includes('โหมดทดลอง') && !(await page.textContent('#status')).includes('ออนไลน์'));
    T('demo: logout button hidden', !(await page.isVisible('#logout')));
    T('demo: company name shown in header', (await page.textContent('#company')).includes('เฟล็กซี่'));
    const stats = await page.evaluate(() => ['#n-stock', '#n-sold', '#n-soon'].map(s => +document.querySelector(s).textContent));
    T('demo: seeded stats 2 in stock / 3 sold / 1 expiring soon', JSON.stringify(stats) === '[2,3,1]', stats);

    // รับเข้า
    await page.fill('#r-product', 'Dell XPS 13 9340'); await page.press('#r-product', 'Enter');
    T('receive: brand auto-detected Dell', (await page.inputValue('#r-brand')) === 'Dell');
    T('receive: warranty auto-filled from category default (24)', (await page.inputValue('#r-months')) === '24');
    T('receive: note explains where value came from', (await page.textContent('#r-wnote')).includes('ค่าตั้งต้น'));
    await scan(page, '#r-scan', 'abc 1234567');
    await page.waitForSelector('#r-log li.ok');
    T('receive: scan (lowercase/space) saved as ABC1234567', (await page.textContent('#r-log li.ok .s')) === 'ABC1234567');
    await scan(page, '#r-scan', 'ABC1234567');
    await page.waitForSelector('#r-log li.warn');
    T('receive: duplicate serial warned, count stays 1', (await page.textContent('#r-count')) === '1');
    await scan(page, '#r-scan', 'ab');
    await page.waitForSelector('#r-log li.err');
    T('receive: too-short serial rejected', true);
    await page.fill('#r-product', ''); await scan(page, '#r-scan', 'NOPRODUCT99');
    await page.waitForFunction(() => document.querySelectorAll('#r-log li.err').length >= 2);
    T('receive: missing product name rejected', true);
    await page.fill('#r-product', 'Dell XPS 13 9340');

    // เพิ่มประเภท
    await page.click('#cat-add-toggle'); await page.fill('#cat-new', 'เครื่องพิมพ์'); await page.click('#cat-add-ok');
    await page.waitForFunction(() => [...document.querySelectorAll('#r-cat option')].some(o => o.value === 'เครื่องพิมพ์'));
    T('category: custom category added and selected', (await page.inputValue('#r-cat')) === 'เครื่องพิมพ์');
    await page.selectOption('#r-cat', 'โน้ตบุ๊ก');

    // ขายออก
    await page.click('#tab-sell');
    await page.fill('#s-cust', 'คุณทดสอบ'); await page.fill('#s-inv', 'INV-T-1');
    await scan(page, '#s-scan', 'abc1234567');
    await page.waitForSelector('#s-log li.ok');
    T('sell: marked sold with warranty end shown', (await page.textContent('#s-log li.ok')).includes('ประกันถึง'));
    await scan(page, '#s-scan', 'ABC1234567'); await page.waitForSelector('#s-log li.warn');
    T('sell: selling twice warns', (await page.textContent('#s-log li.warn')).includes('ขายไปแล้ว'));
    await scan(page, '#s-scan', 'UNKNOWN-1234'); await page.waitForSelector('#s-log li.err');
    T('sell: unknown serial errors', (await page.textContent('#s-log li.err')).includes('ไม่พบ'));

    // เช็คประกัน (พนักงาน)
    await page.click('#tab-check'); await scan(page, '#c-scan', 'abc1234567');
    await page.waitForSelector('#c-result .verdict');
    T('staff check: shows in warranty', (await page.textContent('#c-result .verdict .v')) === 'ในประกัน');
    T('staff check: shows customer name', (await page.textContent('#c-result')).includes('คุณทดสอบ'));
    const href = await page.getAttribute('#c-result a.btn', 'href');
    T('staff check: Dell official link present', href && href.startsWith('https://www.dell.com/support/contractservices'), href);
    await scan(page, '#c-scan', 'K2ZXCV77401822D'); await page.waitForFunction(() => document.querySelector('#c-result .verdict .v').textContent.includes('หมดประกัน'));
    T('staff check: expired unit shows หมดประกัน', true);

    // สต็อก
    await page.click('#tab-stock');
    T('stock: table has 6 rows', (await page.locator('#st-body tr').count()) === 6, await page.locator('#st-body tr').count());
    await page.click('[data-f="soon"]'); T('stock: soon filter -> 1 row', (await page.locator('#st-body tr').count()) === 1);
    await page.click('[data-f="all"]'); await page.fill('#st-q', 'dell');
    T('stock: search by product finds Dell unit', (await page.locator('#st-body tr').count()) === 1);
    await page.click('#st-body [data-open]');
    const qrHref = await page.getAttribute('#st-body a[href^="qr.html"]', 'href');
    T('stock: detail has print-QR link', qrHref && qrHref.startsWith('qr.html?s=ABC1234567'), qrHref);
    await page.fill('#st-q', '');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#export')]);
    const csv = fs.readFileSync(await dl.path(), 'utf8');
    T('export: CSV has BOM, header and Thai text', csv.charCodeAt(0) === 0xFEFF && csv.includes('Serial,') && csv.includes('ABC1234567'));
    await page.click('#qr-bulk'); // เปิดแท็บใหม่
    await sleep(300);
    T('bulk QR: queue stored', await page.evaluate(() => JSON.parse(localStorage.getItem('fx.qr.queue')).length) === 6);

    // ยกเลิกการขาย (2 คลิก)
    await page.fill('#st-q', 'ABC1234567');
    if (!(await page.locator('[data-act="unsell"]').count())) await page.click('#st-body [data-open]');
    await page.click('[data-act="unsell"]'); await page.click('[data-act="unsell"]');
    await page.waitForFunction(() => document.querySelector('#st-body .pill') && document.querySelector('#st-body .pill').textContent === 'ในสต็อก');
    T('stock: un-sell (two clicks) returns unit to stock', true);
    // ลบ
    if (!(await page.locator('[data-act="delete"]').count())) await page.click('#st-body [data-open]');
    await page.click('[data-act="delete"]'); await page.click('[data-act="delete"]');
    await page.waitForFunction(() => document.querySelectorAll('#st-body tr').length === 1 && document.querySelector('#st-body .empty'));
    T('stock: delete (two clicks) removes unit', true);
    await page.fill('#st-q', '');

    // ล้างตัวอย่าง
    await page.click('#clear-examples'); await page.click('#clear-examples');
    await page.waitForFunction(() => document.querySelector('#examples').hidden);
    T('examples: clear removes all example units', true);
    await page.screenshot({ path: OUT ? path.join(OUT, 'staff-desktop.png') : undefined }).catch(()=>{});

    // ===== หน้าเช็คของลูกค้า (ต้อง seed ใหม่) =====
    await page.evaluate(() => { localStorage.removeItem('fx.demo.v1'); });
    const cp = await newPage(ctx, errors);
    await cp.setViewportSize({ width: 390, height: 800 });
    const expect = async (serial, txt) => {
      await cp.goto(base + '/check.html?s=' + encodeURIComponent(serial));
      await cp.waitForSelector('#out .result');
      const body = await cp.textContent('#out');
      T('customer: ' + serial + ' shows "' + txt + '"', body.includes(txt), body.slice(0, 120));
    };
    await expect('M4KLTP90817263B', 'อยู่ในประกัน');
    let full = await cp.textContent('body');
    T('customer: no customer name / phone / invoice leaked', !/ลูกค้าตัวอย่าง|081-000|INV-EX|PO-00/.test(full));
    await expect('G7QWER55120934C', 'ใกล้หมดประกัน');
    await expect('K2ZXCV77401822D', 'หมดประกันแล้ว');
    await expect('R9NXCV12345678A', 'ยังไม่พบวันที่ขาย');
    await expect('NOT-A-REAL-SERIAL', 'ไม่พบ Serial นี้');
    await cp.screenshot({ path: OUT ? path.join(OUT, 'customer-phone.png') : undefined }).catch(()=>{});
    await cp.goto(base + '/check.html'); await cp.fill('#serial', 'm4kl tp90817263b'); await cp.click('#go');
    await cp.waitForSelector('#out .result');
    T('customer: manual typing with spaces/lowercase works', (await cp.textContent('#out')).includes('Lenovo IdeaPad'));

    // กล้อง (กล้องปลอมของ Chromium: ตรวจแค่ว่าเปิดได้และปิดได้ ไม่มีบาร์โค้ดจริงให้อ่าน)
    await cp.click('#scan'); await cp.waitForSelector('#reader video', { timeout: 8000 }).catch(() => {});
    T('camera: scanner opens with a video element', await cp.locator('#reader video').count() > 0);
    await cp.click('#cam-x'); T('camera: closes', !(await cp.isVisible('#cam')));

    // ===== พิมพ์ QR แล้วอ่านกลับด้วยตัวสแกนจากรูป =====
    const qp = await newPage(ctx, errors);
    await qp.goto(base + '/qr.html?s=M4KLTP90817263B&p=' + encodeURIComponent('Lenovo IdeaPad Slim 3'));
    await qp.waitForSelector('.st svg');
    T('qr page: sticker rendered with serial text', (await qp.textContent('.st .s')) === 'M4KLTP90817263B');
    T('qr page: warns when base URL is localhost', await qp.isVisible('#base-warn'));
    await qp.fill('#base', 'https://warranty.example.co.th/check.html');
    T('qr page: warning clears for real https address', !(await qp.isVisible('#base-warn')));
    const png = path.join(require('os').tmpdir(), 'qr-test-' + process.pid + '.png');
    await qp.locator('.st .q').screenshot({ path: png });
    await cp.goto(base + '/check.html');
    await cp.setInputFiles('#photo', png);
    await cp.waitForSelector('#out .result', { timeout: 15000 }).catch(() => {});
    const qrRes = await cp.textContent('#out');
    T('QR photo: decoded URL -> serial -> result (QR end to end)', qrRes.includes('Lenovo IdeaPad') || qrRes.includes('ไม่พบ'), qrRes.slice(0, 100));
    T('QR photo: decoded the right serial', await cp.inputValue('#serial') === 'M4KLTP90817263B', await cp.inputValue('#serial'));
    // คิวพิมพ์หลายป้าย
    await qp.evaluate(() => localStorage.setItem('fx.qr.queue', JSON.stringify([{s:'AAAA1111',p:'x'},{s:'BBBB2222',p:'y'},{s:'CCCC3333',p:''}])));
    await qp.goto(base + '/qr.html?q=1'); await qp.waitForSelector('.st svg');
    T('qr page: bulk queue renders 3 stickers', (await qp.locator('.st').count()) === 3);
    await qp.screenshot({ path: OUT ? path.join(OUT, 'qr-page.png') : undefined }).catch(()=>{});

    T('demo: no page errors', errors.length === 0, errors);
    await ctx.close();
  }

  /* ===================== ส่วนที่ 2: โหมด Supabase (ตัวจำลอง) ===================== */
  {
    const errors = [];
    const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 } });
    await ctx.route('**/config.js', r => r.fulfill({ contentType: 'text/javascript', body: "window.APP_CONFIG={COMPANY:'ทดสอบ',COMPANY_PHONE:'044-111-222',SUPABASE_URL:'https://x.supabase.co',SUPABASE_ANON_KEY:'anon'};" }));
    await ctx.route('**/vendor/supabase.js', r => r.fulfill({ contentType: 'text/javascript', body: FAKE_SUPABASE }));
    const page = await newPage(ctx, errors);
    await page.goto(base + '/index.html');
    await page.waitForSelector('#login:not([hidden])');
    T('supabase: login form shown, app hidden', await page.isVisible('#login') && !(await page.isVisible('#app')));
    await page.fill('#l-email', 'staff@flexi.test'); await page.fill('#l-pw', 'wrong'); await page.click('#l-go');
    await page.waitForSelector('#l-err:not([hidden])');
    T('supabase: wrong password shows Thai error', (await page.textContent('#l-err')).includes('ไม่ถูกต้อง'));
    await page.fill('#l-pw', 'goodpass1'); await page.click('#l-go');
    await page.waitForSelector('#app:not([hidden])');
    T('supabase: login opens app, shows staff email', (await page.textContent('#who')) === 'staff@flexi.test');
    T('supabase: demo banner NOT shown', !(await page.isVisible('#demo-note')));
    await page.waitForFunction(() => document.querySelector('#status').className.includes('live'));
    T('supabase: status shows connected', true);
    await page.fill('#r-product', 'MSI Katana 15'); await page.press('#r-product', 'Enter');
    await scan(page, '#r-scan', 'MSI-KAT-0001'); await page.waitForSelector('#r-log li.ok');
    await page.click('#tab-sell'); await page.fill('#s-cust', 'ลูกค้าจริง'); await scan(page, '#s-scan', 'msi-kat-0001'); await page.waitForSelector('#s-log li.ok');
    const stored = await page.evaluate(() => { const r = [...window.__fake.rows.values()].filter(x => x.collection === 'units'); return r.map(x => x.data); });
    T('supabase: unit stored via upsert/update with sold status + brand', stored.length === 1 && stored[0].status === 'sold' && stored[0].brand === 'MSI' && !!stored[0].warrantyEnd, stored);
    T('supabase: id is normalised serial', await page.evaluate(() => window.__fake.rows.has('units|MSI-KAT-0001')));
    await page.click('#tab-stock');
    T('supabase: stock table reflects the write (cache + realtime)', (await page.locator('#st-body tr').count()) === 1);
    // เพิ่มประเภท + ค่าตั้งต้นประกัน
    await page.click('#tab-receive'); await page.click('#cat-add-toggle'); await page.fill('#cat-new', 'เร้าเตอร์'); await page.click('#cat-add-ok');
    await page.waitForFunction(() => window.__fake.rows.has('settings|lists'));
    T('supabase: custom category saved to settings/lists', await page.evaluate(() => window.__fake.rows.get('settings|lists').data.categories.includes('เร้าเตอร์')));
    await page.click('#defs > summary'); await page.fill('#df-0', '30'); await page.click('#defs-save');
    await page.waitForFunction(() => window.__fake.rows.has('settings|warranty'));
    T('supabase: warranty defaults saved', await page.evaluate(() => window.__fake.rows.get('settings|warranty').data.defaults['โน้ตบุ๊ก'] === 30));
    // รีโหลด: session ยังอยู่ (จำลองด้วย sessionStorage) ต้องเข้าได้ทันที — ตัวจำลองไม่เก็บ session ข้ามโหลด จึงต้องล็อกอินอีกครั้ง
    // หน้าลูกค้าใช้ rpc
    const cp = await newPage(ctx, errors);
    await cp.goto(base + '/check.html?s=MSI-KAT-0001');
    await cp.waitForSelector('#out .result');
    const body = await cp.textContent('body');
    T('supabase: public page calls rpc and shows result', body.includes('MSI Katana 15') && (await page.evaluate(() => window.__fake.rpcCalls())) === 0 && (await cp.evaluate(() => window.__fake.rpcCalls())) === 1);
    T('supabase: phone shown from config', body.includes('044-111-222'));
    T('supabase: public page does not leak customer', !body.includes('ลูกค้าจริง'));
    // รีโหลดแล้วต้องยังอยู่ในระบบ (session เดิม)
    await page.reload(); await page.waitForSelector('#app:not([hidden])');
    T('supabase: reload keeps staff logged in', (await page.textContent('#who')) === 'staff@flexi.test');
    await page.waitForFunction(() => document.querySelector('#status').className.includes('live'));
    T('supabase: data survives reload (loaded from backend)', await page.evaluate(() => document.querySelector('#n-sold').textContent) === '1');
    // ออกจากระบบ
    await page.click('#logout'); await page.waitForSelector('#login:not([hidden])');
    T('supabase: logout returns to login', true);
    T('supabase: no page errors', errors.length === 0, errors);
    await ctx.close();
  }

  await browser.close(); server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('TEST CRASH', e); process.exit(2); });
