// ====== Sidebar toggle (mobile) ======
(function(){
  const btn = document.getElementById('btnToggle');
  const sidebar = document.getElementById('sidebar');
  btn?.addEventListener('click', ()=> sidebar.classList.toggle('open'));
  sidebar?.querySelectorAll('a[href^="#"]').forEach(a=>{
    a.addEventListener('click',()=> sidebar.classList.remove('open'));
  });
})();

// ====== Utils ======
const TZ_WIB = 'Asia/Jakarta';
const dayNames = ['Senin','Selasa','Rabu','Kamis','Jumat','Sabtu','Minggu'];

function showToast(msg, isErr=false, ms=4000){
  const wrap = document.getElementById('toast');
  const div = document.createElement('div');
  div.className = 't' + (isErr ? ' err' : '');
  div.textContent = msg;
  wrap.appendChild(div);
  setTimeout(()=> { div.style.opacity='0'; div.style.transform='translateY(-6px)'; }, ms-250);
  setTimeout(()=> wrap.removeChild(div), ms);
}
const fmtDate = (d) => new Date(d).toLocaleDateString('id-ID', { timeZone: TZ_WIB, year:'numeric', month:'2-digit', day:'2-digit' });
const fmtTime = (d) => new Date(d).toLocaleTimeString('id-ID', { timeZone: TZ_WIB, hour:'2-digit', minute:'2-digit', hour12:false });
function fmtRange(st, et){
  const sDate = fmtDate(st), eDate = fmtDate(et);
  const sTime = fmtTime(st), eTime = fmtTime(et);
  return sDate === eDate ? `${sDate} ${sTime} – ${eTime} WIB` : `${sDate} ${sTime} → ${eDate} ${eTime} WIB`;
}
function escapeHtmlAdmin(s){ return (s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function hhmmValid(s){ return /^\d{2}:\d{2}$/.test(s); }

// ====== Badge count global ======
async function loadCount(){
  try{
    const r = await fetch('/api/admin/requests/new_count', { cache:'no-store' });
    const j = await r.json();
    document.querySelector('#newCount').textContent = j.count ?? 0;
  }catch{ document.querySelector('#newCount').textContent = '0'; }
}
loadCount(); setInterval(loadCount, 5000);

// ====== REQUESTS ======
(function initRequests(){
  const tbody = document.getElementById('tbody');
  const fstatus = document.getElementById('fstatus');
  const refreshBtn = document.getElementById('refreshBtn');
  const prevBtn = document.getElementById('prevPage');
  const nextBtn = document.getElementById('nextPage');
  const pageInfo = document.getElementById('pageInfo');
  if(!tbody) return; // tidak ada section

  let allRequests = [], currentPage = 1; const PAGE_SIZE = 10;

  function pill(status){
    if(status === 'New') return '<span class="status s-new">New</span>';
    if(status === 'In-Progress') return '<span class="status s-prog">In-Progress</span>';
    return '<span class="status s-done">Done</span>';
  }
  function updatePager(){
    const total = allRequests.length;
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    if (currentPage > totalPages) currentPage = totalPages;
    if (currentPage < 1) currentPage = 1;
    pageInfo.textContent = `Page ${currentPage}/${totalPages}`;
    prevBtn.disabled = currentPage <= 1;
    nextBtn.disabled = currentPage >= totalPages;
  }
  function renderPage(){
    tbody.innerHTML = '';
    const start = (currentPage - 1) * PAGE_SIZE;
    const slice = allRequests.slice(start, start + PAGE_SIZE);
    slice.forEach(item => {
      const tr = document.createElement('tr');
      const timeString = new Date(item.created_at).toLocaleString('id-ID', { timeZone: TZ_WIB, hour12:false });
      tr.innerHTML = `
        <td style="font-family:monospace">${item._id}</td>
        <td>${item.name}</td>
        <td>${item.phone || '-'}</td>
        <td>${item.title}</td>
        <td>${timeString} WIB</td>
        <td>${pill(item.status)}</td>
        <td>
          <button data-st="New" data-id="${item._id}">Set New</button>
          <button data-st="In-Progress" data-id="${item._id}">In-Progress</button>
          <button data-st="Done" data-id="${item._id}">Done</button>
        </td>`;
      tbody.appendChild(tr);
    });
    updatePager();
    // bind actions
    tbody.querySelectorAll('button[data-id]').forEach(btn=>{
      btn.addEventListener('click', async ()=>{
        const id = btn.getAttribute('data-id');
        const status = btn.getAttribute('data-st');
        const r = await fetch('/api/admin/requests/' + id + '/status', {
          method:'POST', headers:{'Content-Type':'application/json'},
          body:JSON.stringify({status})
        });
        const j = await r.json();
        if(j.ok){ showToast('Status diperbarui.'); }
        else { showToast(j.error || 'Gagal update status', true); }
        loadData();
      });
    });
  }
  async function loadData(){
    const qs = fstatus.value ? ('?status=' + encodeURIComponent(fstatus.value)) : '';
    const res = await fetch('/api/admin/requests' + qs, { cache:'no-store' });
    const data = await res.json();
    allRequests = data.items || [];
    currentPage = 1;
    renderPage();
    loadCount();
  }
  prevBtn.addEventListener('click', ()=>{ currentPage--; renderPage(); });
  nextBtn.addEventListener('click', ()=>{ currentPage++; renderPage(); });
  fstatus.addEventListener('change', loadData);
  refreshBtn.addEventListener('click', loadData);

  loadData();
  setInterval(() => { if(!fstatus.value || fstatus.value === 'New'){ loadData(); } }, 5000);
})();

// ====== JADWAL SIARAN ======
(function initSchedules(){
  const schTitle = document.getElementById('schTitle');
  const schHost  = document.getElementById('schHost');
  const schStart = document.getElementById('schStart');
  const schEnd   = document.getElementById('schEnd');
  const schDesc  = document.getElementById('schDesc');
  const schBody  = document.getElementById('schBody');
  const btnAddSch = document.getElementById('btnAddSch');
  const btnReloadSch = document.getElementById('btnReloadSch');
  const schMsg   = document.getElementById('schMsg');
  if(!schBody) return;

  function toUTCISOFromLocal(localStr){
    if(!localStr) return null;
    const [datePart, timePart] = localStr.split('T');
    const [y, m, d] = datePart.split('-').map(Number);
    const [hh, mm]  = timePart.split(':').map(Number);
    const utcMs = Date.UTC(y, m - 1, d, hh - 7, mm, 0, 0); // WIB = UTC+7
    return new Date(utcMs).toISOString();
  }
  async function addSchedule(){
    schMsg.textContent = '';
    const startISO = toUTCISOFromLocal(schStart.value);
    const endISO   = toUTCISOFromLocal(schEnd.value);
    if(!schTitle.value.trim()){ schMsg.textContent='Judul program wajib diisi.'; return; }
    if(!startISO || !endISO){ schMsg.textContent='Waktu mulai & selesai wajib diisi.'; return; }
    if(new Date(endISO) <= new Date(startISO)){ schMsg.textContent='Waktu selesai harus setelah waktu mulai.'; return; }
    const payload = {
      title: schTitle.value.trim(),
      host: schHost.value.trim(),
      description: schDesc.value.trim(),
      start_time: startISO, end_time: endISO
    };
    try{
      const r = await fetch('/api/admin/schedules', {
        method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload)
      });
      const j = await r.json();
      if(!j.ok) throw new Error(j.error||'Gagal menyimpan.');
      schTitle.value = schHost.value = schDesc.value = '';
      schStart.value = schEnd.value = '';
      showToast('Jadwal siaran ditambahkan.');
      await loadSchedules();
    }catch(e){
      schMsg.textContent = e.message || 'Gagal menyimpan.'; showToast(schMsg.textContent, true);
    }
  }
  async function loadSchedules(){
    const r = await fetch('/api/admin/schedules', { cache:'no-store' });
    const j = await r.json();
    schBody.innerHTML = '';
    (j.items||[]).forEach(it => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${fmtRange(it.start_time, it.end_time)}</td>
                      <td>${it.title}</td>
                      <td>${it.host||''}</td>
                      <td>${it.description||''}</td>
                      <td><button data-del="${it._id}">Hapus</button></td>`;
      tr.querySelector('[data-del]').addEventListener('click', async (e)=>{
        const id = e.currentTarget.getAttribute('data-del');
        if(confirm('Hapus jadwal ini?')){
          const r = await fetch('/api/admin/schedules/'+id, {method:'DELETE'});
          const j = await r.json();
          if(j.ok){ showToast('Jadwal dihapus.'); } else { showToast(j.error||'Gagal hapus', true); }
          loadSchedules();
        }
      });
      schBody.appendChild(tr);
    });
  }
  btnAddSch?.addEventListener('click', addSchedule);
  btnReloadSch?.addEventListener('click', loadSchedules);
  loadSchedules();
})();

// ====== PLAYLIST ======
(function initPlaylist(){
  const plTimelineWrap = document.getElementById('plTimelineWrap');
  const dayTabs = document.getElementById('dayTabs');
  const plDaySel = document.getElementById('plDay');
  const plProgram = document.getElementById('plProgram');
  const plStart = document.getElementById('plStart');
  const plEnd   = document.getElementById('plEnd');
  const plTracks = document.getElementById('plTracks');
  const btnAddPl = document.getElementById('btnAddPl');
  const btnReloadPl = document.getElementById('btnReloadPl');
  const plExportCsv = document.getElementById('plExportCsv');
  const plImportCsv = document.getElementById('plImportCsv');
  const plCsvFile   = document.getElementById('plCsvFile');
  const plCsvMode   = document.getElementById('plCsvMode');
  if(!plTimelineWrap) return;

  let playlistData = [];
  let activeDay = new Date().getDay() - 1; if(activeDay < 0) activeDay = 6;

  function setupDays(){
    plDaySel.innerHTML = '';
    dayTabs.innerHTML = '';
    dayNames.forEach((nm, i)=>{
      const opt = document.createElement('option');
      opt.value = i; opt.textContent = nm + (i===activeDay?' (hari ini)':'');
      plDaySel.appendChild(opt);

      const btn = document.createElement('button');
      btn.className = 'day-tab' + (i===activeDay?' active':'');
      btn.textContent = nm;
      if(i===activeDay){
        const badge = document.createElement('span');
        badge.className = 'today-badge'; badge.textContent = 'Hari ini';
        btn.appendChild(badge);
      }
      btn.addEventListener('click', ()=> setActiveDay(i));
      dayTabs.appendChild(btn);
    });
    plDaySel.value = String(activeDay);
  }
  setupDays();

  function setActiveDay(d){
    activeDay = d;
    [...dayTabs.children].forEach((el, idx)=> el.classList.toggle('active', idx===activeDay));
    plDaySel.value = String(activeDay);
    renderTimeline();
  }
  function sortForDay(a, b){
    const ak = (a.sort_key ?? 0), bk = (b.sort_key ?? 0);
    if (ak !== bk) return ak - bk;
    return (a.start_hhmm||'').localeCompare(b.start_hhmm||'');
  }
  function isLiveSlot(day, start, end){
    try{
      const now = new Date();
      const nowWIB = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Jakarta' }));
      const nowDay = (nowWIB.getDay()+6)%7;
      if(nowDay !== day) return false;
      const [sh, sm] = (start||'00:00').split(':').map(Number);
      const [eh, em] = (end  ||'00:00').split(':').map(Number);
      const mins = nowWIB.getHours()*60 + nowWIB.getMinutes();
      const s = sh*60+sm, e = eh*60+em;
      return mins >= s && mins < e;
    }catch{ return false; }
  }
  function button(text, attrs={}){
    const b = document.createElement('button');
    b.textContent = text;
    Object.entries(attrs).forEach(([k,v]) => b.setAttribute(k, v));
    return b;
  }
  async function sendReorder(day, ids){
    const r = await fetch('/api/admin/playlist/reorder', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ day, ids })
    });
    const j = await r.json();
    if(!j.ok) throw new Error(j.error || 'Gagal menyimpan urutan.');
  }
  async function moveItem(day, id, delta){
    const arr = (playlistData.filter(x=>x.day===day)).sort(sortForDay);
    const idx = arr.findIndex(x => x._id === id);
    if (idx < 0) return;
    const to = idx + delta;
    if (to < 0 || to >= arr.length) return;
    const ids = arr.map(x=>x._id);
    const [picked] = ids.splice(idx, 1);
    ids.splice(to, 0, picked);
    try{
      await sendReorder(day, ids);
      await loadPlaylist();
      setActiveDay(day);
      showToast('Urutan diperbarui.');
    }catch(e){ showToast(e.message || 'Gagal mengurutkan.', true); }
  }
  function renderTimeline(){
    plTimelineWrap.innerHTML = '';
    const day = activeDay;
    const arr = playlistData.filter(it => it.day === day).sort(sortForDay);
    if(!arr.length){
      plTimelineWrap.innerHTML = `<div class="empty">Belum ada playlist untuk ${dayNames[day]}.</div>`;
      return;
    }
    const wrap = document.createElement('div'); wrap.className = 'timeline';
    arr.forEach((it, i) => {
      const live = isLiveSlot(it.day, it.start_hhmm, it.end_hhmm);
      const row = document.createElement('div');
      row.className = 'slot' + (live ? ' live' : '');
      row.setAttribute('data-id', it._id);
      const top = document.createElement('div'); top.className = 'top';
      const timechip = document.createElement('span'); timechip.className = 'timechip'; timechip.textContent = `${it.start_hhmm}–${it.end_hhmm} WIB`;
      const prog = document.createElement('span'); prog.className = 'prog'; prog.textContent = it.program || '-';
      const actions = document.createElement('span'); actions.className = 'act'; actions.style.marginLeft = 'auto';
      const upBtn = button('▲', {'title':'Naik'}); const dnBtn = button('▼', {'title':'Turun'}); const delBtn = button('Hapus', {'data-del': it._id, 'title':'Hapus'});
      upBtn.disabled = (i === 0); dnBtn.disabled = (i === arr.length - 1);
      upBtn.addEventListener('click', ()=> moveItem(day, it._id, -1));
      dnBtn.addEventListener('click', ()=> moveItem(day, it._id, +1));
      delBtn.addEventListener('click', async ()=>{
        if(!confirm('Hapus item playlist ini?')) return;
        const r = await fetch('/api/admin/playlist/'+it._id, { method:'DELETE' });
        const j = await r.json();
        if(j.ok){ showToast('Item playlist dihapus.'); await loadPlaylist(); setActiveDay(day); }
        else { showToast(j.error||'Gagal hapus item', true); }
      });
      actions.append(upBtn,dnBtn,delBtn);
      top.append(timechip,prog,actions);
      const tracks = document.createElement('div'); tracks.className = 'tracks'; tracks.textContent = it.tracks || '';
      row.append(top,tracks);
      wrap.appendChild(row);
    });
    plTimelineWrap.appendChild(wrap);
  }
  async function loadPlaylist(){
    const r = await fetch('/api/admin/playlist', { cache:'no-store' });
    const j = await r.json();
    playlistData = j.items || [];
    renderTimeline();
  }
  async function addPlaylist(){
    const day = parseInt(plDaySel.value, 10);
    const start_hhmm = (plStart.value||'').trim();
    const end_hhmm   = (plEnd.value||'').trim();
    const program    = (plProgram.value||'').trim();
    const tracks     = (plTracks.value||'').trim();
    if(!program){ showToast('Program wajib diisi.', true); return; }
    if(!hhmmValid(start_hhmm) || !hhmmValid(end_hhmm)){ showToast('Format waktu harus HH:MM.', true); return; }
    try{
      const r = await fetch('/api/admin/playlist', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ day, start_hhmm, end_hhmm, program, tracks })
      });
      const j = await r.json();
      if(!j.ok) throw new Error(j.error||'Gagal menyimpan playlist.');
      plProgram.value = plTracks.value = ''; plStart.value = plEnd.value = '';
      showToast('Playlist ditambahkan.');
      await loadPlaylist();
      setActiveDay(day);
    }catch(e){ showToast(e.message || 'Gagal menyimpan playlist.', true); }
  }
  btnAddPl?.addEventListener('click', addPlaylist);
  btnReloadPl?.addEventListener('click', loadPlaylist);
  plExportCsv?.addEventListener('click', () => window.open('/api/admin/playlist/csv', '_blank'));
  plImportCsv?.addEventListener('click', () => plCsvFile.click());
  plCsvFile?.addEventListener('change', async () => {
    const f = plCsvFile.files[0]; if (!f) return;
    try{
      const fd = new FormData();
      fd.append('file', f);
      fd.append('mode', plCsvMode.value);
      const r = await fetch('/api/admin/playlist/csv', { method:'POST', body: fd });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'Gagal import CSV.');
      showToast(`Import sukses. Inserted: ${j.inserted}, Updated: ${j.updated}`);
      await loadPlaylist();
      setActiveDay(activeDay);
    }catch(e){ showToast(e.message || 'Gagal import CSV.', true); }
    finally{ plCsvFile.value = ''; }
  });
  loadPlaylist();
})();

// ====== CHAT ======
(function initChat(){
  const chatBody = document.getElementById('chatBody');
  const chatReload = document.getElementById('chatReload');
  const chatFlagOnly = document.getElementById('chatFlagOnly');
  if(!chatBody) return;

  async function loadChatList(){
    const qs = chatFlagOnly.checked ? '?flagged=1&limit=200' : '?limit=200';
    const r = await fetch('/api/admin/chat'+qs, { cache:'no-store' });
    const j = await r.json();
    chatBody.innerHTML = '';
    (j.items||[]).forEach(it=>{
      const timeString = new Date(it.ts).toLocaleString('id-ID', { timeZone: TZ_WIB, hour12:false });
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${timeString} WIB</td>
        <td>${escapeHtmlAdmin(it.name)}</td>
        <td>${escapeHtmlAdmin(it.text)}</td>
        <td>${escapeHtmlAdmin(it.ip||'-')}</td>
        <td>${it.flagged ? '<span class="status s-prog">Flagged</span>' : '-'}</td>
        <td><button data-del="${it._id}">Hapus</button></td>`;
      tr.querySelector('[data-del]').addEventListener('click', async (e)=>{
        const id = e.currentTarget.getAttribute('data-del');
        if(confirm('Hapus pesan ini?')){
          const r = await fetch('/api/admin/chat/'+id, {method:'DELETE'});
          const j = await r.json();
          if(j.ok){ showToast('Pesan dihapus.'); } else { showToast(j.error||'Gagal hapus', true); }
          loadChatList();
        }
      });
      chatBody.appendChild(tr);
    });
  }
  chatReload?.addEventListener('click', loadChatList);
  chatFlagOnly?.addEventListener('change', loadChatList);
  setInterval(loadChatList, 5000);
  loadChatList();
})();

// ====== YOUTUBE LINKER ======
(function initYT(){
  const ytListEl  = document.getElementById('ytList');
  const ytQueryEl = document.getElementById('ytQuery');
  const ytBtnCari = document.getElementById('ytBtnCari');
  const ytUrlEl   = document.getElementById('ytUrl');
  const ytBtnCopy = document.getElementById('ytBtnCopy');
  const ytBtnOpen = document.getElementById('ytBtnOpen');
  const ytBtnConv = document.getElementById('ytBtnConv');
  if(!ytListEl) return;

  function ytBuildSearchURL(q){ return 'https://www.youtube.com/results?search_query=' + encodeURIComponent((q||'').trim()); }
  function extractYouTubeId(input){
    try{
      const s = (input||'').trim();
      if(/^[a-zA-Z0-9_-]{11}$/.test(s)) return s;
      const u = new URL(s);
      const host = u.hostname.replace(/^www\./,'').toLowerCase();
      if(!/(^|\.)((music\.)?youtube\.com|youtu\.be)$/.test(host)) return null;
      if (u.pathname.startsWith('/results') || u.pathname.startsWith('/channel') || u.pathname.startsWith('/@') || u.pathname.startsWith('/playlist') || u.pathname.startsWith('/feed')) return null;
      if (u.pathname === '/attribution_link' && u.searchParams.get('u')) {
        const inner = new URL('https://youtube.com' + u.searchParams.get('u'));
        const v = inner.searchParams.get('v'); if (v) return v;
      }
      const v = u.searchParams.get('v'); if (v) return v;
      if (host.endsWith('youtu.be')) {
        const id = u.pathname.split('/').filter(Boolean)[0]; return id || null;
      }
      const parts = u.pathname.split('/').filter(Boolean);
      if (parts[0] === 'shorts' && parts[1]) return parts[1];
      if (parts[0] === 'embed'  && parts[1]) return parts[1];
      if (parts[0] === 'live'   && parts[1]) return parts[1];
      return null;
    }catch{ return null; }
  }
  function normalizeToWatch(urlOrId){ const id = extractYouTubeId(urlOrId); return id ? `https://www.youtube.com/watch?v=${id}` : null; }
  function normalizeToShort(urlOrId){ const id = extractYouTubeId(urlOrId); return id ? `https://youtu.be/${id}` : null; }

  async function fetchFirstVideoFromQueryOrResults(input){
    const isResults = /https?:\/\/(www\.)?youtube\.com\/results\?/i.test(input);
    const url = isResults
      ? '/api/tools/yt/find_first?url=' + encodeURIComponent(input)
      : '/api/tools/yt/find_first?q='   + encodeURIComponent((input||'').trim());
    const r = await fetch(url, { cache:'no-store' });
    return r.json();
  }

  async function ytCari(){
    const q = (ytQueryEl?.value||'').trim();
    if(!q){ showToast('Masukkan kata kunci.', true); return; }
    ytListEl.innerHTML = '<div class="hint">Mencari…</div>';
    try{
      const r = await fetch('/api/music/search?q=' + encodeURIComponent(q), { cache:'no-store' });
      const j = await r.json();
      const arr = j.data || [];
      if(!arr.length){ ytListEl.innerHTML = '<div class="hint">Tidak ada hasil.</div>'; return; }
      ytListEl.innerHTML = '';
      arr.forEach(t => {
        const query = [t.title, t.artist].filter(Boolean).join(' ');
        const ytSearch = ytBuildSearchURL(query);
        const row = document.createElement('div'); row.className = 'item';
        row.innerHTML = `
          <img src="${t.cover||''}" alt="cover"/>
          <div>
            <div class="title">${t.title||'-'}</div>
            <div class="sub">${t.artist||''}${t.album?(' • '+t.album):''}</div>
            <div class="row" style="margin-top:8px">
              <button data-open>🔗 Buka YouTube (Search)</button>
              <button class="ghost" data-copy>📋 Salin URL Pencarian</button>
              <button class="ghost" data-set>⤴️ Set ke Input (Auto Video 1)</button>
            </div>
          </div>
          <div style="white-space:nowrap" class="sub">Preview: ${t.preview?('<a href="'+t.preview+'" target="_blank">▶</a>'):'-'}</div>`;
        row.querySelector('[data-open]').addEventListener('click', ()=> window.open(ytSearch,'_blank'));
        row.querySelector('[data-copy]').addEventListener('click', async ()=>{
          try{ await navigator.clipboard.writeText(ytSearch); showToast('URL pencarian YouTube disalin.'); }
          catch{ showToast('Gagal menyalin.', true); }
        });
        row.querySelector('[data-set]').addEventListener('click', async ()=>{
          try{
            const res = await fetchFirstVideoFromQueryOrResults(query);
            if(res?.ok && res.url){
              ytUrlEl && (ytUrlEl.value = res.url);
              showToast('Video teratas dipilih otomatis.');
            }else{
              ytUrlEl && (ytUrlEl.value = ytSearch);
              showToast('Gagal auto-pilih video. URL pencarian di-set.', true);
            }
          }catch{
            ytUrlEl && (ytUrlEl.value = ytSearch);
            showToast('Gagal auto-pilih video. URL pencarian di-set.', true);
          }
        });
        ytListEl.appendChild(row);
      });
    }catch{ ytListEl.innerHTML = '<div class="hint">Gagal memuat hasil.</div>'; }
  }

  ytBtnCari?.addEventListener('click', ytCari);
  ytQueryEl?.addEventListener('keydown', (e)=>{ if(e.key==='Enter') ytCari(); });

  ytBtnCopy?.addEventListener('click', async ()=>{
    const u = (ytUrlEl?.value||'').trim();
    if(!u){ showToast('Belum ada URL.', true); return; }
    try{ await navigator.clipboard.writeText(u); showToast('URL disalin.'); }
    catch{ showToast('Gagal menyalin.', true); }
  });

  ytBtnOpen?.addEventListener('click', async ()=>{
    const raw = (ytUrlEl?.value||'').trim();
    if(!raw){ showToast('Isi dulu URL atau kata kunci.', true); return; }
    const isResults = /https?:\/\/(www\.)?youtube\.com\/results\?/i.test(raw);
    if (isResults) {
      const res = await fetchFirstVideoFromQueryOrResults(raw);
      if(res?.ok && res.url){ ytUrlEl.value = res.url; window.open(res.url, '_blank'); return; }
      showToast('Gagal ambil dari link pencarian.', true); return;
    }
    const watchUrl = normalizeToWatch(raw);
    if(!watchUrl){ showToast('URL bukan link video (watch/youtu.be/shorts/embed).', true); return; }
    ytUrlEl.value = watchUrl; window.open(watchUrl, '_blank');
  });

  ytBtnConv?.addEventListener('click', async ()=>{
    const raw = (ytUrlEl?.value||'').trim();
    if(!raw){ showToast('Isi dulu URL atau kata kunci.', true); return; }
    let finalUrl = null;
    const isResults = /https?:\/\/(www\.)?youtube\.com\/results\?/i.test(raw);
    if (isResults) {
      const res = await fetchFirstVideoFromQueryOrResults(raw);
      if(res?.ok && res.url){ finalUrl = res.url; }
    } else { finalUrl = normalizeToWatch(raw) || normalizeToShort(raw); }

    if(!finalUrl){ showToast('Tidak bisa ubah ke link video. Pilih video dulu.', true); return; }
    ytUrlEl.value = finalUrl;
    try{ await navigator.clipboard.writeText(finalUrl); showToast('URL video disalin.'); }catch{}
    window.open('https://www.youtubemp3.ltd/id', '_blank');
  });
})();
