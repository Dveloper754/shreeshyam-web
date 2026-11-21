// Walkie-talkie LISTENER for the website / desktop / pendrive app (listen only —
// the mic is in the mobile app, owner-only). The phone records natively and streams
// 16 kHz PCM over Supabase Realtime broadcast on channel walkie:<user-id>; because
// the employee uses the owner's own login, their id == the owner's, so phone and
// this page meet on the same channel automatically and privately.
import { supabase } from "./supabaseClient.js";

if (supabase) initWalkie();

function initWalkie() {
  const style = document.createElement("style");
  style.textContent = `
  #wk-btn{position:fixed;right:16px;bottom:16px;z-index:9999;display:flex;align-items:center;gap:8px;
    background:#1f4e5f;color:#fff;border:none;border-radius:999px;padding:11px 16px;font:600 14px Inter,Arial,sans-serif;
    box-shadow:0 8px 24px rgba(0,0,0,.25);cursor:pointer}
  #wk-btn.off{background:#5a6b72}
  #wk-btn .ic{font-size:18px;line-height:1}
  #wk-ban{position:fixed;left:50%;top:14px;transform:translateX(-50%);z-index:9999;display:none;
    background:#d62f2f;color:#fff;padding:9px 18px;border-radius:999px;font:700 14px Inter,Arial,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.3)}
  @media print{#wk-btn,#wk-ban{display:none!important}}`;
  document.head.appendChild(style);

  const btn = document.createElement("button");
  btn.id = "wk-btn"; btn.className = "off"; btn.style.display = "none";
  btn.innerHTML = '<span class="ic">🔇</span><span class="lbl">Sound off</span>';
  const ban = document.createElement("div");
  ban.id = "wk-ban"; ban.innerHTML = "🔊 Owner speaking…";
  function addToDom(){ if(document.body){ document.body.appendChild(btn); document.body.appendChild(ban);} else requestAnimationFrame(addToDom); }
  addToDom();

  let armed = false, channel = null, joinedUid = null;
  // ---- PCM (native phone mic) playback ----
  let actx = null, pcmRate = 16000, pcmNext = 0, pcmSid = null;
  // ---- webm/opus (browser mic) playback, kept as a fallback path ----
  let audioEl=null, ms=null, sb=null, queue=[], curSid=null, usingMSE=false, fallbackChunks=null, fallbackMime="";
  const MSE = window.MediaSource || window.WebKitMediaSource;
  const mseOk = (m)=>{ try { return !!MSE && MSE.isTypeSupported(m); } catch(e){ return false; } };
  const b64ToBytes = (b64)=>{ const bin=atob(b64), n=bin.length, u=new Uint8Array(n); for(let i=0;i<n;i++) u[i]=bin.charCodeAt(i); return u; };

  btn.addEventListener("click", ()=>{
    armed = !armed;
    if (armed){
      try { const Ctx=window.AudioContext||window.webkitAudioContext; if(Ctx){ actx = window.__wkCtx = (window.__wkCtx||new Ctx()); actx.resume(); } } catch(e){}
      try { const a=new Audio(); a.muted=true; a.play().catch(()=>{}); } catch(e){}
      btn.className=""; btn.querySelector(".lbl").textContent="Sound on"; btn.querySelector(".ic").textContent="🔊";
    } else {
      stopPlayback();
      btn.className="off"; btn.querySelector(".lbl").textContent="Sound off"; btn.querySelector(".ic").textContent="🔇";
    }
  });

  // ---- PCM path ----
  function pcmStart(sid, rate){
    pcmSid = sid; pcmRate = rate || 16000; showBanner(true);
    if (!armed) return;
    try { const Ctx=window.AudioContext||window.webkitAudioContext; if(Ctx){ actx = window.__wkCtx = (window.__wkCtx||new Ctx()); actx.resume(); } } catch(e){}
    if (actx) pcmNext = actx.currentTime + 0.18;   // small jitter buffer
  }
  function pcmChunk(sid, bytes){
    if (sid !== pcmSid || !armed || !actx) return;
    // bytes -> aligned Int16 -> Float32 [-1,1)
    let i16;
    try { const abuf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); i16 = new Int16Array(abuf); }
    catch(e){ return; }
    const f32 = new Float32Array(i16.length);
    for (let i=0;i<i16.length;i++) f32[i] = i16[i] / 32768;
    let abuffer;
    try { abuffer = actx.createBuffer(1, f32.length, pcmRate); } catch(e){ return; }
    abuffer.getChannelData(0).set(f32);
    const src = actx.createBufferSource(); src.buffer = abuffer; src.connect(actx.destination);
    const t = Math.max(pcmNext, actx.currentTime + 0.02);
    try { src.start(t); } catch(e){ return; }
    pcmNext = t + abuffer.duration;
  }
  function pcmStop(sid){ if (sid === pcmSid) { showBanner(false); pcmSid = null; } }

  // ---- webm/opus path (unused by the native phone, kept for completeness) ----
  function onStart(sid, mime){
    stopMse(); curSid=sid; mime=mime||"audio/webm;codecs=opus"; showBanner(true);
    if (!armed) return;
    if (mseOk(mime)){
      usingMSE=true; queue=[]; audioEl=new Audio(); audioEl.autoplay=true; ms=new MSE(); audioEl.src=URL.createObjectURL(ms);
      ms.addEventListener("sourceopen", ()=>{ try{ sb=ms.addSourceBuffer(mime); sb.mode="sequence"; sb.addEventListener("updateend",pump); pump(); }catch(e){ usingMSE=false; } });
      audioEl.play().catch(()=>{});
    } else { usingMSE=false; fallbackChunks=[]; fallbackMime=mime; }
  }
  function onAudio(sid, bytes){ if (sid!==curSid || !armed) return; if (usingMSE){ queue.push(bytes); pump(); } else if (fallbackChunks){ fallbackChunks.push(bytes); } }
  function onStop(sid){
    if (sid!==curSid) return; showBanner(false);
    if (usingMSE){ const end=()=>{ try{ if(ms&&ms.readyState==="open") ms.endOfStream(); }catch(e){} }; if(sb&&!sb.updating&&!queue.length) end(); else setTimeout(end,400); }
    else if (fallbackChunks && fallbackChunks.length && armed){ try{ const b=new Blob(fallbackChunks,{type:fallbackMime}); new Audio(URL.createObjectURL(b)).play().catch(()=>{}); }catch(e){} fallbackChunks=null; }
    curSid=null;
  }
  function pump(){ if(!usingMSE||!sb||sb.updating||!queue.length) return; try{ sb.appendBuffer(queue.shift()); }catch(e){} }
  function stopMse(){ try{ if(audioEl){ audioEl.pause(); audioEl.src=""; } }catch(e){} audioEl=null; ms=null; sb=null; queue=[]; usingMSE=false; fallbackChunks=null; }

  function stopPlayback(){ stopMse(); pcmSid=null; showBanner(false); }
  let banTimer=null;
  function showBanner(on){ if(!ban) return; if(on){ ban.style.display="block"; clearTimeout(banTimer); banTimer=setTimeout(()=>{ban.style.display="none";},15000); } else { ban.style.display="none"; clearTimeout(banTimer); } }

  function join(uid){
    if (joinedUid===uid && channel) return;
    leave(); joinedUid=uid;
    channel = supabase.channel("walkie:"+uid, { config:{ broadcast:{ self:false } } });
    channel
      .on("broadcast", { event:"pcm-start" }, (m)=> pcmStart(m.payload && m.payload.sid, m.payload && m.payload.rate))
      .on("broadcast", { event:"pcm" },       (m)=> m.payload && pcmChunk(m.payload.sid, b64ToBytes(m.payload.b64)))
      .on("broadcast", { event:"pcm-stop" },  (m)=> pcmStop(m.payload && m.payload.sid))
      .on("broadcast", { event:"talk-start" }, (m)=> onStart(m.payload && m.payload.sid, m.payload && m.payload.mime))
      .on("broadcast", { event:"audio" },      (m)=> m.payload && onAudio(m.payload.sid, b64ToBytes(m.payload.b64)))
      .on("broadcast", { event:"talk-stop" },  (m)=> onStop(m.payload && m.payload.sid))
      .subscribe();
    btn.style.display = "flex";
  }
  function leave(){ stopPlayback(); try{ if(channel) supabase.removeChannel(channel); }catch(e){} channel=null; joinedUid=null; }

  async function sync(){
    try { const { data } = await supabase.auth.getSession(); const s=data&&data.session;
      if (s && s.user){ join(s.user.id); btn.style.display="flex"; } else { leave(); btn.style.display="none"; }
    } catch(e){}
  }
  supabase.auth.onAuthStateChange((_e,s)=>{ if(s&&s.user) join(s.user.id); else { leave(); btn.style.display="none"; } });
  sync();
}
