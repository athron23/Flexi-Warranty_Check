/* ชั้นเก็บข้อมูลกลาง (data layer)
 * ทุกหน้าเรียกข้อมูลผ่านไฟล์นี้ไฟล์เดียว ไม่เรียก Supabase ตรง ๆ
 * ถ้าวันหนึ่งย้ายไปรันบน NAS ให้เขียน backend ตัวใหม่ในไฟล์นี้ (ดู makeDb)
 * โดยหน้าเว็บไม่ต้องแก้
 *
 * window.Data = {
 *   mode: 'demo' | 'supabase',
 *   company, phone,
 *   db.doc('units/ID').get/set/update/delete/onSnapshot
 *   db.collection('units').onSnapshot
 *   auth.user() / signIn(email, pw) / signOut()
 *   publicCheck(serial)  -> เช็คประกันสำหรับลูกค้า (ไม่มีข้อมูลส่วนตัว)
 *   stateFromEnd(endYmd, todayYmd) -> {state, days}
 *   download(filename, text)
 * }
 */
(function () {
  'use strict';
  var C = window.APP_CONFIG || {};
  var demo = !(C.SUPABASE_URL && C.SUPABASE_ANON_KEY);
  var D = { mode: demo ? 'demo' : 'supabase', company: C.COMPANY || '', phone: C.COMPANY_PHONE || '' };

  /* ---------- helpers ---------- */
  function mkErr(code, msg) { var e = new Error(msg || code); e.code = code; return e; }
  function snap(id, data) {
    return { id: id, exists: data != null, data: function () { return data == null ? undefined : data; } };
  }
  function merge(a, b) {
    var out = Object.assign({}, a);
    Object.keys(b).forEach(function (k) {
      var v = b[k];
      if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) out[k] = merge(out[k], v);
      else out[k] = v;
    });
    return out;
  }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function ymd(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function parseYmd(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ''));
    return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
  }
  function addMonths(d, m) {
    var x = new Date(d.getFullYear(), d.getMonth(), 1);
    x.setMonth(x.getMonth() + m);
    var last = new Date(x.getFullYear(), x.getMonth() + 1, 0).getDate();
    return new Date(x.getFullYear(), x.getMonth(), Math.min(d.getDate(), last));
  }
  function normSerial(s) { return String(s || '').replace(/\s+/g, '').toUpperCase(); }

  /* สถานะประกันจากวันสิ้นสุด: exp / soon (<=30 วัน) / inw */
  D.stateFromEnd = function (endStr, todayStr) {
    var end = parseYmd(endStr), today = parseYmd(todayStr) || new Date();
    if (!end) return { state: 'stock', days: null };
    var t = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    var days = Math.round((end - t) / 864e5);
    return { state: days < 0 ? 'exp' : (days <= 30 ? 'soon' : 'inw'), days: days };
  };

  D.download = function (filename, text) {
    return new Promise(function (resolve, reject) {
      try {
        var blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url; a.download = filename; a.style.display = 'none';
        document.body.appendChild(a); a.click();
        setTimeout(function () { URL.revokeObjectURL(url); a.remove(); resolve({ status: 'saved' }); }, 500);
      } catch (e) { reject(e); }
    });
  };

  /* ---------- db API ที่หน้าเว็บใช้ (สร้างบน backend ใด ๆ ก็ได้) ----------
   * backend ต้องมี: get(coll,id) put(coll,id,data) del(coll,id) watch(coll,cb(map),onErr)->unsubscribe */
  function makeDb(b) {
    function docRef(path) {
      var p = String(path).split('/'), coll = p[0], id = p[1];
      return {
        get: function () { return b.get(coll, id).then(function (d) { return snap(id, d); }); },
        set: function (d) { return b.put(coll, id, d); },
        update: function (d) {
          return b.get(coll, id).then(function (cur) {
            if (cur == null) throw mkErr('invalid_argument', 'document does not exist');
            return b.put(coll, id, merge(cur, d));
          });
        },
        delete: function () { return b.del(coll, id); },
        onSnapshot: function (next, error) {
          return b.watch(coll, function (map) { next(snap(id, map.has(id) ? map.get(id) : null)); }, error);
        }
      };
    }
    function colRef(coll) {
      return {
        onSnapshot: function (next, error) {
          return b.watch(coll, function (map) {
            var docs = []; map.forEach(function (v, k) { docs.push(snap(k, v)); });
            next({ docs: docs, size: docs.length, empty: !docs.length });
          }, error);
        }
      };
    }
    return { doc: docRef, collection: colRef };
  }

  /* ---------- backend: โหมดทดลอง (localStorage) ---------- */
  function demoBackend() {
    var KEY = 'fx.demo.v1', subs = {};
    function load() { try { return JSON.parse(localStorage.getItem(KEY)) || null; } catch (e) { return null; } }
    function save(st) { try { localStorage.setItem(KEY, JSON.stringify(st)); } catch (e) { throw mkErr('quota_exceeded'); } }
    function seed() {
      var now = new Date(), st = { units: {}, settings: {} };
      function add(serial, product, brand, cat, sup, soldMonthsAgo, soldDaysAgo, months, customer, phone, inv) {
        var u = { serial: serial, product: product, brand: brand, category: cat, supplier: sup, warrantyMonths: months,
          status: 'in_stock', receivedAt: new Date(now - 200 * 864e5).toISOString(), example: true };
        if (soldMonthsAgo != null) {
          var sold = addMonths(now, -soldMonthsAgo); sold = new Date(sold.getTime() - (soldDaysAgo || 0) * 864e5);
          u.status = 'sold'; u.soldAt = sold.toISOString(); u.customer = customer; u.phone = phone; u.invoice = inv;
          u.warrantyEnd = ymd(addMonths(sold, months));
        }
        st.units[serial] = u;
      }
      add('R9NXCV12345678A', 'ASUS TUF Gaming A15 FA507NV', 'ASUS', 'โน้ตบุ๊ก', 'ตัวอย่าง PO-001', null, 0, 36);
      add('M4KLTP90817263B', 'Lenovo IdeaPad Slim 3 15IAH8', 'Lenovo', 'โน้ตบุ๊ก', 'ตัวอย่าง PO-002', 3, 0, 36, 'ลูกค้าตัวอย่าง ก', '081-000-0001', 'INV-EX-001');
      add('G7QWER55120934C', 'MSI Pulsar 16 HX', 'MSI', 'โน้ตบุ๊ก', 'ตัวอย่าง PO-003', 36, -10, 36, 'ลูกค้าตัวอย่าง ข', '081-000-0002', 'INV-EX-002');
      add('K2ZXCV77401822D', 'Acer Aspire 5 A515-58P', 'Acer', 'โน้ตบุ๊ก', 'ตัวอย่าง PO-004', 40, 0, 36, 'ลูกค้าตัวอย่าง ค', '081-000-0003', 'INV-EX-003');
      add('VGA3060T12009955', 'GIGABYTE RTX 4060 Ti EAGLE OC 8GB', 'GIGABYTE', 'การ์ดจอ', 'ตัวอย่าง PO-005', null, 0, 36);
      save(st); return st;
    }
    function state() { return load() || seed(); }
    function notify(coll) { (subs[coll] || []).slice().forEach(function (s) { s.fire(); }); }
    window.addEventListener('storage', function (e) { if (e.key === KEY) Object.keys(subs).forEach(notify); });
    function mapOf(coll) { var o = state()[coll] || {}, m = new Map(); Object.keys(o).forEach(function (k) { m.set(k, o[k]); }); return m; }
    D._demoState = state;
    return {
      get: function (coll, id) { return Promise.resolve((state()[coll] || {})[id] || null); },
      put: function (coll, id, d) {
        var st = state(); (st[coll] = st[coll] || {})[id] = JSON.parse(JSON.stringify(d)); save(st); notify(coll); return Promise.resolve();
      },
      del: function (coll, id) { var st = state(); if (st[coll]) delete st[coll][id]; save(st); notify(coll); return Promise.resolve(); },
      watch: function (coll, cb) {
        var s = { fire: function () { cb(mapOf(coll)); } };
        (subs[coll] = subs[coll] || []).push(s);
        setTimeout(function () { s.fire(); }, 0);
        return function () { subs[coll] = (subs[coll] || []).filter(function (x) { return x !== s; }); };
      }
    };
  }

  /* ---------- backend: Supabase ---------- */
  function supabaseBackend() {
    var sb = window.supabase.createClient(C.SUPABASE_URL, C.SUPABASE_ANON_KEY, { auth: { persistSession: true, autoRefreshToken: true } });
    D._sb = sb;
    var watchers = {};

    function mapErr(e) {
      if (!e) return mkErr('unavailable');
      var code = String(e.code || ''), st = e.status;
      if (code === '42501' || code === 'PGRST301' || code === 'PGRST302' || st === 401 || st === 403) return mkErr('invalid_argument', e.message);
      if (code === '53100' || code === '54000') return mkErr('quota_exceeded', e.message);
      if (st === 429) return mkErr('resource_exhausted', e.message);
      return mkErr('unavailable', e.message);
    }
    function fetchAll(coll) {
      var out = new Map(), size = 1000;
      function page(from) {
        return sb.from('docs').select('id,data').eq('collection', coll).order('id').range(from, from + size - 1).then(function (r) {
          if (r.error) throw mapErr(r.error);
          (r.data || []).forEach(function (row) { out.set(row.id, row.data); });
          return (r.data || []).length === size ? page(from + size) : out;
        });
      }
      return page(0);
    }
    function W(coll) { return watchers[coll] || (watchers[coll] = { map: null, subs: [], started: false, timer: null, ch: null }); }
    function emit(w) { w.subs.slice().forEach(function (s) { s.cb(w.map); }); }
    function emitErr(w, e) { w.subs.slice().forEach(function (s) { if (s.err) s.err(e); }); }
    function refresh(coll) {
      var w = W(coll);
      return fetchAll(coll).then(function (m) { w.map = m; emit(w); }, function (e) { emitErr(w, e); });
    }
    function start(coll) {
      var w = W(coll); w.started = true;
      refresh(coll);
      try {
        w.ch = sb.channel('docs-' + coll).on('postgres_changes',
          { event: '*', schema: 'public', table: 'docs', filter: 'collection=eq.' + coll },
          function (p) {
            if (!w.map) return;
            if (p.eventType === 'DELETE') { if (p.old && p.old.id != null) w.map.delete(p.old.id); }
            else if (p.new && p.new.id != null) w.map.set(p.new.id, p.new.data);
            w.map = new Map(w.map); emit(w);
          }).subscribe();
      } catch (e) { /* ใช้การดึงซ้ำทุก 60 วินาทีแทน */ }
      w.timer = setInterval(function () { if (!document.hidden) refresh(coll); }, 60000);
    }
    function stop(coll) {
      var w = W(coll);
      if (w.timer) clearInterval(w.timer);
      if (w.ch) { try { sb.removeChannel(w.ch); } catch (e) {} }
      watchers[coll] = null;
    }
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) Object.keys(watchers).forEach(function (c) { if (watchers[c] && watchers[c].started) refresh(c); });
    });

    return {
      get: function (coll, id) {
        return sb.from('docs').select('data').eq('collection', coll).eq('id', id).maybeSingle().then(function (r) {
          if (r.error) throw mapErr(r.error);
          return r.data ? r.data.data : null;
        });
      },
      put: function (coll, id, d) {
        return sb.from('docs').upsert({ collection: coll, id: id, data: d }).then(function (r) {
          if (r.error) throw mapErr(r.error);
          var w = watchers[coll]; if (w && w.map) { w.map = new Map(w.map); w.map.set(id, d); emit(w); }
        });
      },
      del: function (coll, id) {
        return sb.from('docs').delete().eq('collection', coll).eq('id', id).then(function (r) {
          if (r.error) throw mapErr(r.error);
          var w = watchers[coll]; if (w && w.map) { w.map = new Map(w.map); w.map.delete(id); emit(w); }
        });
      },
      watch: function (coll, cb, onErr) {
        var w = W(coll), sub = { cb: cb, err: onErr };
        w.subs.push(sub);
        if (w.map) cb(w.map);
        if (!w.started) start(coll);
        return function () {
          var cur = watchers[coll]; if (!cur) return;
          cur.subs = cur.subs.filter(function (x) { return x !== sub; });
          if (!cur.subs.length) stop(coll);
        };
      }
    };
  }

  /* ---------- เช็คประกันสำหรับลูกค้า ---------- */
  function demoPublicCheck(serial, backend) {
    var s = normSerial(serial);
    if (s.length < 4 || s.length > 64) return Promise.resolve({ ok: false, error: 'invalid' });
    return backend.get('units', s.replace(/[^A-Z0-9_\-+@:]/g, function (c) { return '~' + c.charCodeAt(0).toString(16).toUpperCase(); })).then(function (u) {
      if (!u) return { ok: true, found: false };
      return { ok: true, found: true, serial: u.serial, product: u.product, brand: u.brand || '', category: u.category || '',
        sold: u.status === 'sold', warrantyMonths: u.warrantyMonths, warrantyEnd: u.warrantyEnd || null, today: ymd(new Date()) };
    });
  }

  /* ---------- ประกอบ ---------- */
  if (demo) {
    var be = demoBackend();
    D.db = makeDb(be);
    D.auth = {
      user: function () { return Promise.resolve({ email: 'โหมดทดลอง' }); },
      signIn: function () { return Promise.resolve({ email: 'โหมดทดลอง' }); },
      signOut: function () { return Promise.resolve(); }
    };
    D.publicCheck = function (s) { return demoPublicCheck(s, be); };
  } else {
    var sbe = supabaseBackend();
    D.db = makeDb(sbe);
    D.auth = {
      user: function () {
        return D._sb.auth.getSession().then(function (r) { return r.data && r.data.session ? r.data.session.user : null; });
      },
      signIn: function (email, pw) {
        return D._sb.auth.signInWithPassword({ email: email, password: pw }).then(function (r) {
          if (r.error) throw r.error;
          return r.data.user;
        });
      },
      signOut: function () { return D._sb.auth.signOut(); }
    };
    D.publicCheck = function (serial) {
      return D._sb.rpc('check_warranty', { p_serial: serial }).then(function (r) {
        if (r.error) throw mapErr(r.error);
        return r.data;
      });
    };
  }
  window.Data = D;
})();
