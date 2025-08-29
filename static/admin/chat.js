const { TZ_WIB, showToast, escapeHtmlAdmin } = window.App;
const chatBody = document.getElementById('chatBody');
if (chatBody){
  const chatReload = document.getElementById('chatReload');
  const chatFlagOnly = document.getElementById('chatFlagOnly');

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
        const id = e.currentTarget.dataset.del;
        if(confirm('Hapus pesan ini?')){
          const r = await fetch('/api/admin/chat/'+id, {method:'DELETE'});
          const j = await r.json();
          showToast(j.ok?'Pesan dihapus.':(j.error||'Gagal hapus'), !j.ok);
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
}
