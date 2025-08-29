const { showToast } = window.App;
const ytListEl  = document.getElementById('ytList');
if (ytListEl){
  const ytQueryEl = document.getElementById('ytQuery');
  const ytBtnCari = document.getElementById('ytBtnCari');
  const ytUrlEl   = document.getElementById('ytUrl');
  const ytBtnCopy = document.getElementById('ytBtnCopy');
  const ytBtnOpen = document.getElementById('ytBtnOpen');
  const ytBtnConv = document.getElementById('ytBtnConv');

  const ytSearchURL = (q)=> 'https://www.youtube.com/results?search_query=' + encodeURIComponent((q||'').trim());
  function extractYouTubeId(input){
    try{
      const s=(input||'').trim();
      if(/^[a-zA-Z0-9_-]{11}$/.test(s)) return s;
      const u=new URL(s); const host=u.hostname.replace(/^www\./,'').toLowerCase();
      if(!/(^|\.)((music\.)?youtube\.com|youtu\.be)$/.test(host)) return null;
      if(['/results','/channel','/@','/playlist','/feed'].some(p=>u.pathname.startsWith(p))) return null;
      if (u.pathname==='/attribution_link' && u.searchParams.get('u')) {
        const inner=new URL('https://youtube.com'+u.searchParams.get('u'));
        const v=inner.searchParams.get('v'); if(v) return v;
      }
      const v=u.searchParams.get('v'); if(v) return v;
      if(host.endsWith('youtu.be')){ const id=u.pathname.split('/').filter(Boolean)[0]; return id||null; }
      const parts=u.pathname.split('/').filter(Boolean);
      if(parts[0]==='shorts' && parts[1]) return parts[1];
      if(parts[0]==='embed'  && parts[1]) return parts[1];
      if(parts[0]==='live'   && parts[1]) return parts[1];
      return null;
    }catch{ return null; }
  }
  const normalizeToWatch = (x)=>{ const id=extractYouTubeId(x); return id?`https://www.youtube.com/watch?v=${id}`:null; };

  async function findFirstVideo(input){
    const isResults=/https?:\/\/(www\.)?youtube\.com\/results\?/i.test(input);
    const url=isResults?('/api/tools/yt/find_first?url='+encodeURIComponent(input))
                       :('/api/tools/yt/find_first?q='+encodeURIComponent((input||'').trim()));
    const r=await fetch(url,{cache:'no-store'}); return r.json();
  }

  async function ytCari(){
    const q=(ytQueryEl?.value||'').trim();
    if(!q) return showToast('Masukkan kata kunci.', true);
    ytListEl.innerHTML='<div class="hint">Mencari…</div>';
    try{
      const r=await fetch('/api/music/search?q='+encodeURIComponent(q),{cache:'no-store'});
      const j=await r.json(); const arr=j.data||[];
      if(!arr.length){ ytListEl.innerHTML='<div class="hint">Tidak ada hasil.</div>'; return; }
      ytListEl.innerHTML='';
      arr.forEach(t=>{
        const query=[t.title,t.artist].filter(Boolean).join(' ');
        const ytSearch=ytSearchURL(query);
        const row=document.createElement('div'); row.className='item';
        row.innerHTML=`
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
        row.querySelector('[data-open]').onclick=()=> window.open(ytSearch,'_blank');
        row.querySelector('[data-copy]').onclick=async()=>{ try{ await navigator.clipboard.writeText(ytSearch); showToast('URL pencarian YouTube disalin.'); }catch{ showToast('Gagal menyalin.', true); } };
        row.querySelector('[data-set]').onclick=async()=>{
          try{
            const res=await findFirstVideo(query);
            if(res?.ok && res.url){ ytUrlEl.value=res.url; showToast('Video teratas dipilih otomatis.'); }
            else { ytUrlEl.value=ytSearch; showToast('Gagal auto-pilih video. URL pencarian di-set.', true); }
          }catch{ ytUrlEl.value=ytSearch; showToast('Gagal auto-pilih video. URL pencarian di-set.', true); }
        };
        ytListEl.appendChild(row);
      });
    }catch{ ytListEl.innerHTML='<div class="hint">Gagal memuat hasil.</div>'; }
  }

  ytBtnCari?.addEventListener('click', ytCari);
  ytQueryEl?.addEventListener('keydown', (e)=>{ if(e.key==='Enter') ytCari(); });

  ytBtnCopy?.addEventListener('click', async ()=>{
    const u=(ytUrlEl?.value||'').trim(); if(!u) return showToast('Belum ada URL.', true);
    try{ await navigator.clipboard.writeText(u); showToast('URL disalin.'); }catch{ showToast('Gagal menyalin.', true); }
  });

  ytBtnOpen?.addEventListener('click', async ()=>{
    const raw=(ytUrlEl?.value||'').trim(); if(!raw) return showToast('Isi dulu URL atau kata kunci.', true);
    const isResults=/https?:\/\/(www\.)?youtube\.com\/results\?/i.test(raw);
    if(isResults){ const res=await findFirstVideo(raw); if(res?.ok && res.url){ ytUrlEl.value=res.url; window.open(res.url,'_blank'); return; }
      return showToast('Gagal ambil dari link pencarian.', true); }
    const watch=normalizeToWatch(raw); if(!watch) return showToast('URL bukan link video (watch/youtu.be/shorts/embed).', true);
    ytUrlEl.value=watch; window.open(watch,'_blank');
  });

  ytBtnConv?.addEventListener('click', async ()=>{
    const raw=(ytUrlEl?.value||'').trim(); if(!raw) return showToast('Isi dulu URL atau kata kunci.', true);
    let finalUrl=null; const isResults=/https?:\/\/(www\.)?youtube\.com\/results\?/i.test(raw);
    if(isResults){ const res=await findFirstVideo(raw); if(res?.ok && res.url) finalUrl=res.url; }
    else { finalUrl=normalizeToWatch(raw); }
    if(!finalUrl) return showToast('Tidak bisa ubah ke link video. Pilih video dulu.', true);
    ytUrlEl.value=finalUrl; try{ await navigator.clipboard.writeText(finalUrl); showToast('URL video disalin.'); }catch{}
    window.open('https://www.youtubemp3.ltd/id','_blank');
  });
}
