const { showToast, dayNames, hhmmValid } = window.App;
const plTimelineWrap = document.getElementById('plTimelineWrap');
if (plTimelineWrap){
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

  let playlistData = [];
  let activeDay = new Date().getDay() - 1; if(activeDay < 0) activeDay = 6;

  function setupDays(){
    plDaySel.innerHTML = ''; dayTabs.innerHTML = '';
    dayNames.forEach((nm,i)=>{
      const opt = document.createElement('option');
      opt.value = i; opt.textContent = nm + (i===activeDay?' (hari ini)':'');
      plDaySel.appendChild(opt);

      const btn = document.createElement('button');
      btn.className = 'day-tab' + (i===activeDay?' active':'');
      btn.textContent = nm;
      if(i===activeDay){ const b=document.createElement('span'); b.className='today-badge'; b.textContent='Hari ini'; btn.appendChild(b); }
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
  const sortForDay = (a,b) => (a.sort_key??0)-(b.sort_key??0) || (a.start_hhmm||'').localeCompare(b.start_hhmm||'');
  function isLiveSlot(day, start, end){
    try{ const now=new Date(), nowWIB=new Date(now.toLocaleString('en-US',{timeZone:'Asia/Jakarta'}));
      const nowDay=(nowWIB.getDay()+6)%7; if(nowDay!==day) return false;
      const [sh,sm]=(start||'00:00').split(':').map(Number); const [eh,em]=(end||'00:00').split(':').map(Number);
      const mins=nowWIB.getHours()*60+nowWIB.getMinutes(); const s=sh*60+sm,e=eh*60+em; return mins>=s && mins<e;
    }catch{return false;}
  }
  async function sendReorder(day, ids){
    const r = await fetch('/api/admin/playlist/reorder', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ day, ids }) });
    const j = await r.json(); if(!j.ok) throw new Error(j.error||'Gagal menyimpan urutan.');
  }
  async function moveItem(day, id, delta){
    const arr = (playlistData.filter(x=>x.day===day)).sort(sortForDay);
    const idx = arr.findIndex(x=>x._id===id); const to = idx+delta;
    if(idx<0 || to<0 || to>=arr.length) return;
    const ids=arr.map(x=>x._id); const [pick]=ids.splice(idx,1); ids.splice(to,0,pick);
    try{ await sendReorder(day, ids); await loadPlaylist(); setActiveDay(day); showToast('Urutan diperbarui.'); }catch(e){ showToast(e.message||'Gagal mengurutkan.', true); }
  }
  function renderTimeline(){
    plTimelineWrap.innerHTML=''; const day=activeDay;
    const arr=playlistData.filter(it=>it.day===day).sort(sortForDay);
    if(!arr.length){ plTimelineWrap.innerHTML = `<div class="empty">Belum ada playlist untuk ${dayNames[day]}.</div>`; return; }
    const wrap = document.createElement('div'); wrap.className='timeline';
    arr.forEach((it,i)=>{
      const row=document.createElement('div'); row.className='slot'+(isLiveSlot(it.day,it.start_hhmm,it.end_hhmm)?' live':'');
      const top=document.createElement('div'); top.className='top';
      const time=document.createElement('span'); time.className='timechip'; time.textContent=`${it.start_hhmm}–${it.end_hhmm} WIB`;
      const prog=document.createElement('span'); prog.className='prog'; prog.textContent = it.program||'-';
      const act=document.createElement('span'); act.className='act'; act.style.marginLeft='auto';
      const up=document.createElement('button'); up.textContent='▲'; up.title='Naik'; up.disabled=(i===0);
      const dn=document.createElement('button'); dn.textContent='▼'; dn.title='Turun'; dn.disabled=(i===arr.length-1);
      const del=document.createElement('button'); del.textContent='Hapus'; del.title='Hapus';
      up.onclick=()=>moveItem(day,it._id,-1); dn.onclick=()=>moveItem(day,it._id,1);
      del.onclick=async()=>{ if(!confirm('Hapus item playlist ini?')) return;
        const r=await fetch('/api/admin/playlist/'+it._id,{method:'DELETE'}); const j=await r.json();
        showToast(j.ok?'Item playlist dihapus.':(j.error||'Gagal hapus'), !j.ok); await loadPlaylist(); setActiveDay(day);
      };
      act.append(up,dn,del); top.append(time,prog,act);
      const tracks=document.createElement('div'); tracks.className='tracks'; tracks.textContent=it.tracks||'';
      row.append(top,tracks); wrap.appendChild(row);
    });
    plTimelineWrap.appendChild(wrap);
  }
  async function loadPlaylist(){
    const r = await fetch('/api/admin/playlist', { cache:'no-store' });
    const j = await r.json(); playlistData=j.items||[]; renderTimeline();
  }
  async function addPlaylist(){
    const day=parseInt(plDaySel.value,10);
    const start_hhmm=(plStart.value||'').trim(); const end_hhmm=(plEnd.value||'').trim();
    const program=(plProgram.value||'').trim(); const tracks=(plTracks.value||'').trim();
    if(!program) return showToast('Program wajib diisi.', true);
    if(!hhmmValid(start_hhmm)||!hhmmValid(end_hhmm)) return showToast('Format waktu harus HH:MM.', true);
    const r=await fetch('/api/admin/playlist',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({day,start_hhmm,end_hhmm,program,tracks})});
    const j=await r.json(); if(!j.ok) return showToast(j.error||'Gagal menyimpan playlist.', true);
    plProgram.value=plTracks.value=''; plStart.value=plEnd.value=''; showToast('Playlist ditambahkan.');
    await loadPlaylist(); setActiveDay(day);
  }
  document.getElementById('btnAddPl')?.addEventListener('click', addPlaylist);
  btnReloadPl?.addEventListener('click', loadPlaylist);
  plExportCsv?.addEventListener('click', ()=> window.open('/api/admin/playlist/csv','_blank'));
  plImportCsv?.addEventListener('click', ()=> plCsvFile.click());
  plCsvFile?.addEventListener('change', async ()=>{
    const f=plCsvFile.files[0]; if(!f) return;
    try{ const fd=new FormData(); fd.append('file',f); fd.append('mode',plCsvMode.value);
      const r=await fetch('/api/admin/playlist/csv',{method:'POST',body:fd}); const j=await r.json();
      if(!j.ok) throw new Error(j.error||'Gagal import CSV.');
      showToast(`Import sukses. Inserted: ${j.inserted}, Updated: ${j.updated}`);
      await loadPlaylist(); setActiveDay(activeDay);
    }catch(e){ showToast(e.message||'Gagal import CSV.', true); } finally{ plCsvFile.value=''; }
  });
  loadPlaylist();
}
