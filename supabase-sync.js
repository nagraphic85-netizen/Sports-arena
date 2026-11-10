/* Sports Arena <-> Supabase সিঙ্ক (v3: ডেটা হারানো রোধে মার্জ সহ)
   - পুশ করার আগে সার্ভারে অন্য কেউ বদলেছে কিনা দেখা হয়; বদলালে দুই পক্ষের কাজ মিলিয়ে (মার্জ) তারপর সেভ হয়।
   - যাচাই হয় শুধু "শেষ বদলের সময়" দিয়ে (ছোট অনুরোধ), তাই ৫ সেকেন্ডেও খরচ কম। */
(function () {
  /* ---------- মার্জ ---------- */
  function isObj(x) { return x && typeof x === 'object' && !Array.isArray(x); }
  function J(x) { return JSON.stringify(x); }
  function keyOf(it) {
    if (it && typeof it === 'object') {
      if (it.id !== undefined) return 'i:' + it.id;
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
  var KEYNAME = 'sa2', BASEKEY = 'sa2_base', STAMPKEY = 'sa2_stamp';
  var orig = Storage.prototype.setItem;
  var remoteStamp = '', base = null, busy = false, applying = false, timer = null;
  try { base = JSON.parse(localStorage.getItem(BASEKEY)); remoteStamp = localStorage.getItem(STAMPKEY) || ''; } catch (e) { base = null; }

  function status(t) { try { window.SYNC_STATUS = t; } catch (e) {} }
  function saveBase(data, stamp) {
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
    return fetch(EP + '?id=eq.1&select=' + (full ? 'data,updated_at' : 'updated_at'), { headers: H })
      .then(function (r) { return r.json(); })
      .then(function (rows) { if (!Array.isArray(rows)) throw new Error('bad response'); return rows[0] || null; });
  }

  /* সার্ভারের সঙ্গে মিলিয়ে নেয়; দরকার হলে মার্জ করে লোকালে বসায়। সার্ভারের সারি ফেরত দেয় */
  function reconcile(row) {
    var loc = localData(), remote = row.data;
    var le = (loc && loc.epoch) || 0, re = (remote && remote.epoch) || 0;   // "সব ডিলিট"-এর রিসেট নম্বর
    var merged = !loc ? remote : re > le ? remote : le > re ? loc : mergeVal(base, loc, remote, !base);
    applyLocal(merged);
    saveBase(remote, row.updated_at);
    return J(merged) !== J(remote);          // true = সার্ভারে পাঠানোর মতো নতুন কিছু আছে
  }

  function push(tries) {
    tries = tries || 0;
    if (busy) return Promise.resolve();
    var loc = localData(); if (!loc) return Promise.resolve();
    if (tries > 5) { status('সিঙ্ক ব্যর্থ (বারবার দ্বন্দ্ব)'); return Promise.resolve(); }
    busy = true;
    var stamp = new Date().toISOString(), req;
    if (!remoteStamp) {
      req = fetch(EP, { method: 'POST', headers: Object.assign({ Prefer: 'return=representation' }, H),
        body: JSON.stringify([{ id: 1, data: loc, updated_at: stamp }]) });
    } else {
      req = fetch(EP + '?id=eq.1&updated_at=eq.' + encodeURIComponent(remoteStamp), { method: 'PATCH',
        headers: Object.assign({ Prefer: 'return=representation' }, H), body: JSON.stringify({ data: loc, updated_at: stamp }) });
    }
    return req.then(function (r) {
      if (r.status === 409) return 'conflict';
      if (!r.ok) { status('সিঙ্ক ব্যর্থ ' + r.status); return 'fail'; }
      return r.json().then(function (rows) {
        if (Array.isArray(rows) && rows.length) { saveBase(rows[0].data, rows[0].updated_at); status('সিঙ্ক ✔'); return 'ok'; }
        return 'conflict';                   // অন্য কেউ আগে সেভ করেছে
      });
    }).catch(function (e) { status('অফলাইন'); console.error(e); return 'fail'; })
      .then(function (res) {
        busy = false;
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
    if (busy) return Promise.resolve();
    return fetchRow(false).then(function (meta) {
      if (!meta) { if (first && localData()) { remoteStamp = ''; return push(0); } return; }
      if (meta.updated_at === remoteStamp) return;
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
  document.addEventListener('visibilitychange', function () { if (!document.hidden) pull(false); });
})();
