// Buat util global di window.App agar per-page JS bisa pakai tanpa import
(function(){
  const TZ_WIB = 'Asia/Jakarta';
  const dayNames = ['Senin','Selasa','Rabu','Kamis','Jumat','Sabtu','Minggu'];

  function showToast(msg, isErr=false, ms=4000){
    let wrap = document.getElementById('toast');
    if(!wrap){ wrap=document.createElement('div'); wrap.id='toast'; wrap.className='toast'; document.body.appendChild(wrap); }
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

  async function loadCount(){
    try{
      const r = await fetch('/api/admin/requests/new_count', { cache:'no-store' });
      const j = await r.json();
      const el = document.querySelector('#newCount');
      if (el) el.textContent = j.count ?? 0;
    }catch{
      const el = document.querySelector('#newCount');
      if (el) el.textContent = '0';
    }
  }

  // Toggle sidebar (mobile)
  const btn = document.getElementById('btnToggle');
  const sidebar = document.getElementById('sidebar');
  btn?.addEventListener('click', ()=> sidebar.classList.toggle('open'));
  sidebar?.querySelectorAll('a').forEach(a=> a.addEventListener('click', ()=> sidebar.classList.remove('open')));

  window.App = { TZ_WIB, dayNames, showToast, fmtRange, escapeHtmlAdmin, hhmmValid, loadCount };
  loadCount(); setInterval(loadCount, 5000);
})();
