const { TZ_WIB, showToast } = window.App;
const tbody = document.getElementById('tbody');
if (tbody) {
  const fstatus = document.getElementById('fstatus');
  const refreshBtn = document.getElementById('refreshBtn');
  const prevBtn = document.getElementById('prevPage');
  const nextBtn = document.getElementById('nextPage');
  const pageInfo = document.getElementById('pageInfo');

  let allRequests = [], currentPage = 1; const PAGE_SIZE = 10;

  const pill = (status) => (
    status === 'New' ? '<span class="status s-new">New</span>' :
    status === 'In-Progress' ? '<span class="status s-prog">In-Progress</span>' :
    '<span class="status s-done">Done</span>'
  );

  function updatePager(){
    const total = allRequests.length;
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    currentPage = Math.min(Math.max(currentPage,1), totalPages);
    pageInfo.textContent = `Page ${currentPage}/${totalPages}`;
    prevBtn.disabled = currentPage <= 1;
    nextBtn.disabled = currentPage >= totalPages;
  }

  function renderPage(){
    tbody.innerHTML = '';
    const slice = allRequests.slice((currentPage-1)*PAGE_SIZE, (currentPage)*PAGE_SIZE);
    slice.forEach(item=>{
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

    tbody.querySelectorAll('button[data-id]').forEach(btn=>{
      btn.addEventListener('click', async ()=>{
        const r = await fetch(`/api/admin/requests/${btn.dataset.id}/status`, {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({status: btn.dataset.st})
        });
        const j = await r.json();
        showToast(j.ok ? 'Status diperbarui.' : (j.error || 'Gagal update status'), !j.ok);
        loadData();
      });
    });
  }

  async function loadData(){
    const qs = fstatus.value ? `?status=${encodeURIComponent(fstatus.value)}` : '';
    const res = await fetch('/api/admin/requests'+qs, { cache:'no-store' });
    const data = await res.json();
    allRequests = data.items || [];
    currentPage = 1;
    renderPage();
    window.App.loadCount(); // refresh badge
  }

  prevBtn.addEventListener('click', ()=>{ currentPage--; renderPage(); });
  nextBtn.addEventListener('click', ()=>{ currentPage++; renderPage(); });
  fstatus.addEventListener('change', loadData);
  refreshBtn.addEventListener('click', loadData);

  loadData();
  setInterval(()=>{ if(!fstatus.value || fstatus.value==='New') loadData(); }, 5000);
}
