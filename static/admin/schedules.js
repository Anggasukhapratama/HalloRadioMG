const { showToast, fmtRange } = window.App;

const schTitle = document.getElementById('schTitle');
const schHost  = document.getElementById('schHost');
const schStart = document.getElementById('schStart');
const schEnd   = document.getElementById('schEnd');
const schDesc  = document.getElementById('schDesc');
const schBody  = document.getElementById('schBody');
const btnAddSch = document.getElementById('btnAddSch');
const btnReloadSch = document.getElementById('btnReloadSch');
const schMsg   = document.getElementById('schMsg');

function toUTCISOFromLocal(localStr){
  if(!localStr) return null;
  const [d,t] = localStr.split('T');
  const [y,m,dd] = d.split('-').map(Number);
  const [hh,mm]  = t.split(':').map(Number);
  const utcMs = Date.UTC(y, m-1, dd, hh-7, mm, 0, 0); // WIB=UTC+7
  return new Date(utcMs).toISOString();
}

async function addSchedule(){
  schMsg.textContent = '';
  const startISO = toUTCISOFromLocal(schStart.value);
  const endISO   = toUTCISOFromLocal(schEnd.value);
  if(!schTitle.value.trim()) return schMsg.textContent='Judul program wajib diisi.';
  if(!startISO || !endISO)   return schMsg.textContent='Waktu mulai & selesai wajib diisi.';
  if(new Date(endISO) <= new Date(startISO)) return schMsg.textContent='Waktu selesai harus setelah waktu mulai.';
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
    showToast('Jadwal siaran ditambahkan.'); await loadSchedules();
  }catch(e){ schMsg.textContent = e.message||'Gagal menyimpan.'; showToast(schMsg.textContent, true); }
}

async function loadSchedules(){
  const r = await fetch('/api/admin/schedules', { cache:'no-store' });
  const j = await r.json();
  schBody.innerHTML = '';
  (j.items||[]).forEach(it=>{
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${fmtRange(it.start_time, it.end_time)}</td>
                    <td>${it.title}</td>
                    <td>${it.host||''}</td>
                    <td>${it.description||''}</td>
                    <td><button data-del="${it._id}">Hapus</button></td>`;
    tr.querySelector('[data-del]').addEventListener('click', async (e)=>{
      const id = e.currentTarget.dataset.del;
      if(confirm('Hapus jadwal ini?')){
        const r = await fetch('/api/admin/schedules/'+id, {method:'DELETE'});
        const j = await r.json();
        showToast(j.ok ? 'Jadwal dihapus.' : (j.error||'Gagal hapus'), !j.ok);
        loadSchedules();
      }
    });
    schBody.appendChild(tr);
  });
}

btnAddSch?.addEventListener('click', addSchedule);
btnReloadSch?.addEventListener('click', loadSchedules);
loadSchedules();
