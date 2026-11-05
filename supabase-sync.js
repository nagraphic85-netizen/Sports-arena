/* Sports Arena ↔ Supabase সিঙ্ক (লাইব্রেরি ছাড়া, সরাসরি REST)
   পুরো ডেটা app_state টেবিলের id=1 সারিতে JSON হিসেবে থাকে। */
(function () {
  var URL_ = window.SUPABASE_URL, KEY = window.SUPABASE_ANON_KEY;
  if (!URL_ || !KEY || /YOUR-/.test(URL_) || /YOUR-/.test(KEY)) { console.warn('Supabase সেট করা নেই — শুধু লোকাল মোডে চলছে'); return; }
  var EP = URL_ + '/rest/v1/app_state';
  var H = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' };
  var KEYNAME = 'sa2', remoteStamp = '', pushing = false, applying = false, timer = null;
  var orig = Storage.prototype.setItem;

  function status(t) { try { window.SYNC_STATUS = t; } catch (e) {} }

  function push() {
    var data = localStorage.getItem(KEYNAME);
    if (!data || pushing) return;
    pushing = true;
    var stamp = new Date().toISOString();
    fetch(EP + '?on_conflict=id', {
      method: 'POST',
      headers: Object.assign({ Prefer: 'resolution=merge-duplicates,return=minimal' }, H),
      body: JSON.stringify([{ id: 1, data: JSON.parse(data), updated_at: stamp }])
    }).then(function (r) {
      if (r.ok) { remoteStamp = stamp; status('সিঙ্ক ✔'); } else { status('সিঙ্ক ব্যর্থ ' + r.status); console.error('push', r.status); }
    }).catch(function (e) { status('অফলাইন'); console.error(e); }).finally(function () { pushing = false; });
  }

  Storage.prototype.setItem = function (k, v) {
    orig.apply(this, arguments);
    if (k === KEYNAME && !applying) { clearTimeout(timer); timer = setTimeout(push, 1500); }
  };

  function pull(first) {
    return fetch(EP + '?id=eq.1&select=data,updated_at', { headers: H })
      .then(function (r) { return r.json(); })
      .then(function (rows) {
        if (!Array.isArray(rows)) throw new Error('bad response');
        if (!rows.length) { if (first) push(); return; }         // সার্ভারে কিছু নেই → লোকাল ডেটা পাঠাই
        var row = rows[0];
        if (row.updated_at === remoteStamp) return;
        remoteStamp = row.updated_at;
        var s = JSON.stringify(row.data);
        if (s === localStorage.getItem(KEYNAME)) return;
        applying = true; orig.call(localStorage, KEYNAME, s); applying = false;
        window.dispatchEvent(new StorageEvent('storage', { key: KEYNAME, newValue: s }));
        status('আপডেট ✔');
      }).catch(function (e) { status('অফলাইন'); console.error('pull', e); });
  }

  pull(true);
  setInterval(function () { if (!document.hidden && !timer) pull(false); }, 30000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) pull(false); });
})();
