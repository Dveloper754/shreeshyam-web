// Walkie-talkie LISTENER for the website / desktop / pendrive app.
// Whoever is signed in here (the owner's book) hears, live, whatever the owner
// says while holding the mic button in the mobile app. One-way: listen only.
//
// Transport: Supabase Realtime "broadcast" on the channel  walkie:<my-user-id>.
// Because the employee uses the owner's own login, their user id equals the
// owner's, so the phone (talker) and this app (listener) meet on the same
// channel automatically — no routing, and it stays private to this account.
import { supabase } from "./supabaseClient.js";

if (supabase) initWalkie();

function initWalkie() {
  // ---------- UI ----------
  const style = document.createElement("style");
  style.textContent = `
  #wk-btn{position:fixed;right:16px;bottom:16px;z-index:9999;display:flex;align-items:center;gap:8px;
    background:#1f4e5f;color:#fff;border:none;border-radius:999px;padding:11px 16px;font:600 14px Inter,Arial,sans-serif;
    box-shadow:0 8px 24px rgba(0,0,0,.25);cursor:pointer}
  #wk-btn.off{background:#5a6b72}
  #wk-btn .ic{font-size:18px;line-height:1}
  #wk-btn.speaking{background:#d62f2f;animation:wkpulse 1s infinite}
  @keyframes wkpulse{0%,100%{box-shadow:0 0 0 0 rgba(214,47,47,.5)}50%{box-shadow:0 0 0 10px rgba(214,47,47,0)}}
  #wk-ban{position:fixed;left:50%;top:14px;transform:translateX(-50%);z-index:9999;display:none;
    background:#d62f2f;color:#fff;padding:9px 18px;border-radius:999px;font:700 14px Inter,Arial,sans-serif;
    box-shadow:0 8px 24px rgba(0,0,0,.3)}
  #wk-ban .ic{margin-right:7px}
  @media print{#wk-btn,#wk-ban{display:none!important}}`;
  document.head.appendChild(style);

  const btn = document.createElement("button");
  btn.id = "wk-btn"; btn.className = "off";
  btn.innerHTML = '<span class="ic">🔇</span><span class="lbl">Sound off</span>';
  const ban = document.createElement("div");
  ban.id = "wk-ban"; ban.innerHTML = '<span class="ic">🔊</span>Owner speaking…';
  function addToDom(){ if(document.body){ document.body.appendChild(btn); document.body.appendChild(ban);} else { requestAnimationFrame(addToDom);} }
  addToDom();

  // ---------- state ----------
  let armed = false;         // user tapped to allow sound (browser autoplay rule)
  let channel = null, joinedUid = null;
  let audioEl = null, ms = null, sb = null, queue = [], curSid = null, usingMSE = false;
  let fallbackChunks = null, fallbackMime = "";

  const MSE = window.MediaSource || window.WebKitMediaSource;
  function mseOk(mime){ try { return !!MSE && MSE.isTypeSupported(mime); } catch(e){ return false; } }

  btn.addEventListener("click", async () => {
    armed = !armed;
    if (armed) {
      // unlock audio within this user gesture
      try { const Ctx = window.AudioContext||window.webkitAudioContext; if (Ctx){ (window.__wkCtx = window.__wkCtx||new Ctx()).resume(); } } catch(e){}
      try { const a = new Audio(); a.muted = true; a.play().catch(()=>{}); } catch(e){}
      btn.className = ""; btn.querySelector(".lbl").textContent = "Sound on";
      btn.querySelector(".ic").textContent = "🔊";
    } else {
      stopPlayback();
      btn.className = "off"; btn.querySelector(".lbl").textContent = "Sound off";
      btn.querySelector(".ic").textContent = "🔇";
    }
  });

  // ---------- playback ----------
  function b64ToBytes(b64){ const bin = atob(b64); const n=bin.length; const u=new Uint8Array(n); for(let i=0;i<n;i++) u[i]=bin.charCodeAt(i); return u; }

  function onStart(sid, mime){
    stopPlayback();
    curSid = sid;
    mime = mime || "audio/webm;codecs=opus";
    showBanner(true);
    if (!armed){ return; }        // sound is off; show the banner but don't play
    if (mseOk(mime)){
      usingMSE = true; queue = [];
      audioEl = new Audio(); audioEl.autoplay = true;
      ms = new MSE();
      audioEl.src = URL.createObjectURL(ms);
      ms.addEventListener("sourceopen", () => {
        try { sb = ms.addSourceBuffer(mime); sb.mode = "sequence"; sb.addEventListener("updateend", pump); pump(); }
        catch(e){ usingMSE = false; }
      });
      audioEl.play().catch(()=>{});
    } else {
      usingMSE = false; fallbackChunks = []; fallbackMime = mime;   // gather and play on stop
    }
  }
  function onAudio(sid, bytes){
    if (sid !== curSid || !armed) return;
    if (usingMSE){ queue.push(bytes); pump(); }
    else if (fallbackChunks){ fallbackChunks.push(bytes); }
  }
  function onStop(sid){
    if (sid !== curSid){ return; }
    showBanner(false);
    if (usingMSE){
      // let the queue drain, then end the stream
      const end = () => { try { if (ms && ms.readyState==="open") ms.endOfStream(); } catch(e){} };
      if (sb && !sb.updating && !queue.length) end(); else setTimeout(end, 400);
    } else if (fallbackChunks && fallbackChunks.length && armed){
      try {
        const blob = new Blob(fallbackChunks, { type: fallbackMime });
        const a = new Audio(URL.createObjectURL(blob)); a.play().catch(()=>{});
      } catch(e){}
      fallbackChunks = null;
    }
    curSid = null;
  }
  function pump(){
    if (!usingMSE || !sb || sb.updating || !queue.length) return;
    try { sb.appendBuffer(queue.shift()); } catch(e){ /* QuotaExceeded etc. */ }
  }
  function stopPlayback(){
    try { if (audioEl){ audioEl.pause(); audioEl.src=""; } } catch(e){}
    audioEl=null; ms=null; sb=null; queue=[]; usingMSE=false; fallbackChunks=null;
    showBanner(false);
  }
  let banTimer=null;
  function showBanner(on){
    if (!ban) return;
    if (on){ ban.style.display="block"; clearTimeout(banTimer); banTimer=setTimeout(()=>{ban.style.display="none";}, 15000); }
    else { ban.style.display="none"; clearTimeout(banTimer); }
  }

  // ---------- channel wiring ----------
  function join(uid, token){
    if (joinedUid === uid && channel) return;
    leave();
    joinedUid = uid;
    try { if (token) supabase.realtime.setAuth(token); } catch(e){}
    channel = supabase.channel("walkie:"+uid, { config:{ broadcast:{ self:false } } });
    channel
      .on("broadcast", { event:"talk-start" }, (m)=> onStart(m.payload && m.payload.sid, m.payload && m.payload.mime))
      .on("broadcast", { event:"audio" },      (m)=> m.payload && onAudio(m.payload.sid, b64ToBytes(m.payload.b64)))
      .on("broadcast", { event:"talk-stop" },  (m)=> onStop(m.payload && m.payload.sid))
      .subscribe();
    if (btn) btn.style.display = "flex";
  }
  function leave(){
    stopPlayback();
    try { if (channel) supabase.removeChannel(channel); } catch(e){}
    channel=null; joinedUid=null;
  }

  async function sync(){
    try {
      const { data } = await supabase.auth.getSession();
      const s = data && data.session;
      if (s && s.user){ join(s.user.id, s.access_token); if(btn) btn.style.display="flex"; }
      else { leave(); if(btn) btn.style.display="none"; }
    } catch(e){}
  }
  supabase.auth.onAuthStateChange((_e, s)=>{ if (s && s.user) join(s.user.id, s.access_token); else leave(); });
  sync();
}
