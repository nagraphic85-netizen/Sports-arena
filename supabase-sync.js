/* Sports Arena <-> Supabase সিঙ্ক (v6: একাধিক আয়োজন (সারির নম্বর = আয়োজন), মোছা-তালিকা (_tomb), অনুরোধে সময়সীমা, ব্যর্থ পাঠানো আবার চেষ্টা, ব্যাকগ্রাউন্ডে যাওয়ার সময় ফ্লাশ, বিজয়ীর মেলানো আইডি ধরে)
   - পুশ করার আগে সার্ভারে অন্য কেউ বদলেছে কিনা দেখা হয়; বদলালে দুই পক্ষের কাজ মিলিয়ে (মার্জ) তারপর সেভ হয়।
   - যাচাই হয় শুধু "শেষ বদলের সময়" দিয়ে (ছোট অনুরোধ), তাই ৫ সেকেন্ডেও খরচ কম। */
(function () {
  /* ---------- মার্জ ---------- */
  function isObj(x) { return x && typeof x === 'object' && !Array.isArray(x); }
  function J(x) { return JSON.stringify(x); }
  /* কী-এর ক্রম বাদ দিয়ে তুলনা (সুপাবেসের jsonb কী সাজিয়ে ফেরত দেয়, তাই সাধারণ তুলনায় সবসময় 'আলাদা' দেখাত) */
  function C(x) {
    if (Array.isArray(x)) return '[' + x.map(C).join(',') + ']';
    if (x && typeof x === 'object') return '{' + Object.keys(x).sort().map(function (k) { return JSON.stringify(k) + ':' + C(x[k]); }).join(',') + '}';
    return JSON.stringify(x);
  }
  function keyOf(it) {
    if (it && typeof it === 'object') {
      if (it.id !== undefined) return 'i:' + it.id;
      if (it.pid !== undefined && it.pos !== undefined) return 'w:' + it.pos + ':' + it.pid;   // বিজয়ী: স্থান + প্রতিযোগীর আইডি (একই নামের দুজন মিশবে না)
      if (it.name !== undefined) return 'n:' + it.name;
      return 'j:' + J(it);
    }
    return 'p:' + it;
  }
  function mergeArr(b, l, r, noBase) {
    /* ফাঁকা ('') ঘরযুক্ত তালিকা (যেমন সইয়ের ৩টা ঘর) জায়গা ধরে মেলে — একসঙ্গে একটা মান হিসেবে */
    function hasEmpty(a) { return Array.isArray(a) && a.some(function (x) { return x === '' || x === null; }); }
    if (hasEmpty(b) || hasEmpty(l) || hasEmpty(r)) {
      if (!Array.isArray(l)) return r;
      if (!Array.isArray(r)) return l;
      if (noBase) return r.some(function (x) { return x; }) ? r : l;
      return J(l) !== J(b) ? l : r;
    }
    b = Array.isArray(b) ? b : []; l = Array.isArray(l) ? l : []; r = Array.isArray(r) ? r : [];
    var mb = {}, ml = {}, mr = {}, out = [], seen = {};
    b.forEach(function (x) { mb[keyOf(x)] = x; });
    l.forEach(function (x) { ml[keyOf(x)] = x; });
    r.forEach(function (x) { mr[keyOf(x)] = x; });
    function decide(k) {
      var hb = k in mb, hl = k in ml, hr = k in mr;
      if (hl && hr) { if (noBase) return mr[k]; return J(ml[k]) !== J(mb[k]) ? ml[k] : mr[k]; }
      if (hl) { if (hb) return J(ml[k]) !== J(mb[k]) ? ml[k] : undefined; return ml[k]; }  // অন্য পক্ষ মুছেছে
      if (hr) { if (hb) return J(mr[k]) !== J(mb[k]) ? mr[k] : undefined; return mr[k]; }  // এই পক্ষ মুছেছে
    }
    r.concat(l).forEach(function (x) {
      var k = keyOf(x); if (seen[k]) return; seen[k] = 1;
      var v = decide(k); if (v !== undefined) out.push(v);
    });
    if (out.length && out.every(function (x) { return x && typeof x === 'object' && x.pid !== undefined && typeof x.pos === 'number'; })) out.sort(function (a, c) { return a.pos - c.pos; });
    return out;
  }
  function mergeVal(b, l, r, noBase) {
    if (Array.isArray(l) || Array.isArray(r)) return mergeArr(b, l, r, noBase);
    if (isObj(l) && isObj(r)) {
      var out = {}, bb = isObj(b) ? b : {}, ks = {};
      Object.keys(l).concat(Object.keys(r)).forEach(function (k) { ks[k] = 1; });
      Object.keys(ks).forEach(function (k) {
        var v = mergeVal(bb[k], l[k], r[k], noBase);
        if (v !== undefined) out[k] = v;
      });
      return out;
    }
    if (l === undefined) return (b !== undefined && r === b) ? undefined : r;
    if (r === undefined) return (b !== undefined && l === b) ? undefined : l;
    if (noBase) return r;
    return J(l) !== J(b) ? l : r;
  }
  window.__saMerge = function (b, l, r, noBase) { return mergeVal(b, l, r, !!noBase); };

  /* ---------- সিঙ্ক ---------- */
  var URL_ = window.SUPABASE_URL, KEY = window.SUPABASE_ANON_KEY;
  if (!URL_ || !KEY || /YOUR-/.test(URL_) || /YOUR-/.test(KEY)) { console.warn('Supabase সেট করা নেই — শুধু লোকাল মোডে চলছে'); return; }
  var EP = URL_ + '/rest/v1/app_state';
  var H = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' };
  var EVN = window.SA_EV || 1, KEYNAME = window.SA_KEY || 'sa2', BASEKEY = KEYNAME + '_base', STAMPKEY = KEYNAME + '_stamp';   // আয়োজন ১-এর নাম আগের মতোই ('sa2'), বাকিগুলো 'sa2_e<নম্বর>'
  var orig = Storage.prototype.setItem;
  var remoteStamp = '', base = null, busy = false, applying = false, timer = null;
  try { base = JSON.parse(localStorage.getItem(BASEKEY)); remoteStamp = localStorage.getItem(STAMPKEY) || ''; } catch (e) { base = null; }

  var TMO = window.SA_TIMEOUT || 20000;
  function tfetch(url, opt) {            // সময়সীমাসহ fetch: ঝুলে থাকা অনুরোধ সিঙ্ক আটকাবে না
    opt = opt || {};
    if (typeof AbortController === 'undefined') return fetch(url, opt);
    var ac = new AbortController(), t = setTimeout(function () { ac.abort(); }, TMO);
    opt.signal = ac.signal;
    return fetch(url, opt).then(function (r) { clearTimeout(t); return r; }, function (e) { clearTimeout(t); throw e; });
  }
  var busyAt = 0;
  function setBusy(v) { busy = v; busyAt = v ? Date.now() : 0; }
  function isBusy() { if (busy && Date.now() - busyAt > TMO * 2) { busy = false; } return busy; }
  /* _sid: সার্ভারের সারি প্রথম যে বানায় সে একটা র‍্যান্ডম চিহ্ন বসায়। টেবিল নতুন করে বানালে চিহ্ন বদলায় — তখন ডিভাইস পুরনো base ভুলে সব ডেটা মিলিয়ে নেয় (কিছু 'মুছে গেছে' ভাবে না) */
  function withSid(l) { if (l && base && base._sid && !l._sid) { var o = {}; Object.keys(l).forEach(function (k) { o[k] = l[k]; }); o._sid = base._sid; return o; } return l; }
  function dirty() { var l = localData(); return !!l && !!base && C(withSid(l)) !== C(base); }
  var retryT = null, retryN = 0;
  function retryLater() { if (retryT) return; retryN++; retryT = setTimeout(function () { retryT = null; push(0); }, Math.min(60000, 5000 * retryN)); }

  function status(t) { try { window.SYNC_STATUS = t; } catch (e) {} }
  /* ---------- মোছা-তালিকা (v5) ----------
     যে ডিভাইস কিছু মোছে সে সার্ভারে আইডি জমা রাখে (_tomb); পুরনো ডেটা নিয়ে ফেরা ডিভাইস সেটা আর ফেরাতে পারে না।
     মান: [সময়, 1=মোছা | 0=পরে আবার যোগ হয়েছে]; নতুন সময়ই জেতে। */
  var TK = KEYNAME + '_tomb', WL = ['u', 'a', 'r', 'n', 'e', 'vd', 'ctx', 'sg'], tomb = {};
  try { tomb = JSON.parse(localStorage.getItem(TK)) || {}; } catch (e) { tomb = {}; }
  function saveTomb() { try { orig.call(localStorage, TK, J(tomb)); } catch (e) {} }
  function intake(d) {                   // সার্ভারের ডেটা থেকে _tomb আলাদা করে নেয়; বাকিটা ফেরত দেয়
    if (!d || !d._tomb) return d;
    var rt = d._tomb, o = {}, ch = false;
    Object.keys(rt).forEach(function (k) { if (!tomb[k] || tomb[k][0] < rt[k][0]) { tomb[k] = rt[k]; ch = true; } });
    if (ch) saveTomb();
    Object.keys(d).forEach(function (k) { if (k !== '_tomb') o[k] = d[k]; });
    return o;
  }
  function kmap(v) {
    var m = {};
    if (Array.isArray(v)) v.forEach(function (x) { if (x && typeof x === 'object' && x.id !== undefined) m[keyOf(x)] = 1; });
    else if (isObj(v)) Object.keys(v).forEach(function (k) { m['o:' + k] = 1; });
    return m;
  }
  function noteDel(loc) {                // base বনাম লোকাল: কী মুছেছে / আবার যোগ হয়েছে
    if (!base || !loc) return;
    var now = new Date().toISOString(), ch = false;
    WL.forEach(function (n) {
      var bk = kmap(base[n]), lk = kmap(loc[n]);
      Object.keys(bk).forEach(function (k) { if (!lk[k]) { var t = tomb[n + '|' + k]; if (!t || !t[1]) { tomb[n + '|' + k] = [now, 1]; ch = true; } } });
      Object.keys(lk).forEach(function (k) { if (!bk[k]) { var t = tomb[n + '|' + k]; if (t && t[1]) { tomb[n + '|' + k] = [now, 0]; ch = true; } } });
    });
    var old = Date.now() - 120 * 864e5, old0 = Date.now() - 14 * 864e5;
    Object.keys(tomb).forEach(function (k) { var t = Date.parse(tomb[k][0]); if (t < (tomb[k][1] ? old : old0)) { delete tomb[k]; ch = true; } });
    if (ch) saveTomb();
  }
  function withTomb(o) { if (!Object.keys(tomb).length) return o; var x = {}; Object.keys(o).forEach(function (k) { x[k] = o[k]; }); x._tomb = tomb; return x; }
  function applyTomb(m, loc, noB) {      // মোছা তালিকার জিনিস মার্জের ফল থেকে বাদ; যেটা এই ডিভাইস সদ্য নতুন যোগ করেছে সেটা থাকে
    if (!m || !Object.keys(tomb).length) return m;
    var o = {}, bch = false;
    Object.keys(m).forEach(function (k) { o[k] = m[k]; });
    WL.forEach(function (n) {
      var v = o[n]; if (!v) return;
      var bk = noB || !base ? null : kmap(base[n]), lk = kmap(loc && loc[n]);
      function dead(k) { var t = tomb[n + '|' + k]; if (!t || !t[1]) return false; return !(bk && !bk[k] && lk[k]); }
      if (Array.isArray(v)) { var f = v.filter(function (x) { return !(x && typeof x === 'object' && x.id !== undefined && dead(keyOf(x))); }); if (f.length !== v.length) { o[n] = f; bch = true; } }
      else if (isObj(v)) { var c = {}, h = false; Object.keys(v).forEach(function (k) { if (dead('o:' + k)) h = true; else c[k] = v[k]; }); if (h) { o[n] = c; bch = true; } }
    });
    return bch ? o : m;
  }

  function saveBase(data, stamp) {
    data = intake(data);
    base = data; remoteStamp = stamp;
    try { orig.call(localStorage, BASEKEY, J(data)); orig.call(localStorage, STAMPKEY, stamp); } catch (e) {}
  }
  function localData() { try { return JSON.parse(localStorage.getItem(KEYNAME)); } catch (e) { return null; } }
  function appBusy() { try { return typeof _svT !== 'undefined' && !!_svT; } catch (e) { return false; } }

  function applyLocal(obj) {
    var s = J(obj);
    if (s === localStorage.getItem(KEYNAME)) return;
    applying = true; orig.call(localStorage, KEYNAME, s); applying = false;
    window.dispatchEvent(new StorageEvent('storage', { key: KEYNAME, newValue: s }));
  }

  function fetchRow(full) {
    return tfetch(EP + '?id=eq.' + EVN + '&select=' + (full ? 'data,updated_at' : 'updated_at'), { headers: H })
      .then(function (r) { return r.json(); })
      .then(function (rows) { if (!Array.isArray(rows)) throw new Error('bad response'); return rows[0] || null; });
  }

  /* সার্ভারের সঙ্গে মিলিয়ে নেয়; দরকার হলে মার্জ করে লোকালে বসায়। সার্ভারের সারি ফেরত দেয় */
  function reconcile(row) {
    var loc = localData(), rt0 = row.data && row.data._tomb, remote = intake(row.data);
    var le = (loc && loc.epoch) || 0, re = (remote && remote.epoch) || 0;   // "সব ডিলিট"-এর রিসেট নম্বর
    var recreated = !!base && (base._sid || '') !== ((remote && remote._sid) || '');
    var merged = !loc ? remote : re > le ? remote : le > re ? loc : mergeVal(recreated ? null : base, loc, remote, !base || recreated);
    merged = applyTomb(merged, loc, recreated || !base);
    applyLocal(merged);
    saveBase(remote, row.updated_at);
    return C(merged) !== C(remote) || C(tomb) !== C(rt0 || {});          // true = সার্ভারে পাঠানোর মতো নতুন কিছু আছে
  }

  /* মোছা আয়োজন: সারি না থাকলে আর events তালিকাতেও না থাকলে এই ডিভাইস নতুন করে সারি বানাবে না — আয়োজন ১-এ ফিরে যাবে */
  var evOk = EVN === 1;
  function leaveEv() {
    try { [KEYNAME, BASEKEY, STAMPKEY, TK].forEach(function (k) { localStorage.removeItem(k); }); localStorage.setItem('sa_ev', '1'); localStorage.setItem('sa_evc', ''); localStorage.setItem('sa_evn', ''); } catch (e) {}
    location.reload();
  }
  function checkEv() {
    if (evOk) return Promise.resolve(true);
    return tfetch(URL_ + '/rest/v1/events?id=eq.' + EVN + '&select=id', { headers: H })
      .then(function (r) { return r.json(); })
      .then(function (j) { if (Array.isArray(j) && j.length === 0) { leaveEv(); return false; } evOk = true; return true; })
      .catch(function () { return false; });
  }
  function push(tries, keep) {
    tries = tries || 0;
    if (isBusy()) return Promise.resolve();
    var loc = localData(); if (!loc) return Promise.resolve();
    if (!remoteStamp && !evOk) return checkEv().then(function (ok) { if (ok) return push(tries, keep); });
    if (tries > 5) { status('সিঙ্ক ব্যর্থ (বারবার দ্বন্দ্ব)'); return Promise.resolve(); }
    setBusy(true);
    noteDel(loc);
    var stamp = new Date().toISOString(), req;
    if (!remoteStamp) {
      var d1 = Object.assign({}, withTomb(loc), { _sid: Math.random().toString(36).slice(2) + Date.now().toString(36) });
      var b1 = JSON.stringify([{ id: EVN, data: d1, updated_at: stamp }]);
      req = tfetch(EP, { method: 'POST', headers: Object.assign({ Prefer: 'return=representation' }, H), body: b1, keepalive: !!keep && b1.length < 60000 });
    } else {
      var b2 = JSON.stringify({ data: withTomb(withSid(loc)), updated_at: stamp });
      req = tfetch(EP + '?id=eq.' + EVN + '&updated_at=eq.' + encodeURIComponent(remoteStamp), { method: 'PATCH',
        headers: Object.assign({ Prefer: 'return=representation' }, H), body: b2, keepalive: !!keep && b2.length < 60000 });
    }
    return req.then(function (r) {
      if (r.status === 409) return 'conflict';
      if (!r.ok) { status('সিঙ্ক ব্যর্থ ' + r.status); return 'fail'; }
      return r.json().then(function (rows) {
        if (Array.isArray(rows) && rows.length) { saveBase(rows[0].data, rows[0].updated_at); status('সিঙ্ক ✔'); retryN = 0; return 'ok'; }
        return 'conflict';                   // অন্য কেউ আগে সেভ করেছে
      });
    }).catch(function (e) { status('অফলাইন'); console.error(e); return 'fail'; })
      .then(function (res) {
        setBusy(false);
        if (res === 'fail') { retryLater(); return; }
        if (res !== 'conflict') return;
        return fetchRow(true).then(function (row) {
          if (!row) { remoteStamp = ''; return push(tries + 1); }
          reconcile(row);
          return push(tries + 1);
        }).catch(function (e) { status('অফলাইন'); console.error(e); });
      });
  }

  Storage.prototype.setItem = function (k, v) {
    orig.apply(this, arguments);
    if (k === KEYNAME && !applying) { clearTimeout(timer); timer = setTimeout(function () { timer = null; push(0); }, 1500); }
  };

  function pull(first) {
    if (isBusy()) return Promise.resolve();
    return fetchRow(false).then(function (meta) {
      if (!meta) {                           // সার্ভারে সারি নেই (টেবিল নতুন/ফাঁকা): পুরনো base ভুলে সব ডেটা মিলিয়ে তোলা, যাতে কিছু 'মুছে গেছে' ভাবা না হয়
        if (localData()) { base = null; remoteStamp = ''; try { localStorage.removeItem(BASEKEY); localStorage.removeItem(STAMPKEY); } catch (e) {} return push(0); }
        return;
      }
      if (meta.updated_at === remoteStamp) { if (!timer && !retryT && !appBusy() && dirty()) push(0); return; }   // সার্ভারে যায়নি এমন লোকাল ডেটা থাকলে আবার পাঠাও
      if (appBusy()) return;                 // অ্যাপ এইমাত্র সেভ করছে, একটু পরে
      return fetchRow(true).then(function (row) {
        if (!row) return;
        var needPush = reconcile(row);
        status('আপডেট ✔');
        if (needPush) { clearTimeout(timer); timer = setTimeout(function () { timer = null; push(0); }, 300); }
      });
    }).catch(function (e) { status('অফলাইন'); console.error('pull', e); });
  }

  pull(true);
  var tk = 0;
  setInterval(function () { if (typeof ME !== 'undefined' && !ME && ++tk % 6) return; if (!document.hidden && !timer) pull(false); }, 5000);
  function flush() { if (timer) { clearTimeout(timer); timer = null; push(0, true); } else if (dirty()) push(0, true); }
  document.addEventListener('visibilitychange', function () { if (document.hidden) flush(); else pull(false); });
  window.addEventListener('pagehide', flush);
  window.addEventListener('online', function () { pull(false); if (dirty()) push(0); });
})();
