<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>TrackMyPlacements</title>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/react/18.2.0/umd/react.production.min.js"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.2.0/umd/react-dom.production.min.js"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/babel-standalone/7.23.2/babel.min.js"></script>
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,300;9..40,400;9..40,500;9..40,600;9..40,700&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet" />
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html { -webkit-font-smoothing: antialiased; }
    body { background: #0e0e10; font-family: 'DM Sans', sans-serif; min-height: 100vh; }
    @keyframes fadeUp  { from { opacity:0; transform:translateY(12px); } to { opacity:1; transform:translateY(0); } }
    @keyframes spin    { to { transform:rotate(360deg); } }
    @keyframes sweep   { from { transform:translateX(-100%); } to { transform:translateX(600%); } }
    @keyframes pulse   { 0%,100% { transform:scale(1); opacity:1; } 50% { transform:scale(1.15); opacity:.8; } }
    @keyframes breathe { 0%,100% { opacity:.7; } 50% { opacity:1; } }
    input, button { font-family: 'DM Sans', sans-serif; }
    input { outline: none; }
    a { color: #c8a96e; text-decoration: none; }
    a:hover { text-decoration: underline; }
    ::-webkit-scrollbar { width: 3px; }
    ::-webkit-scrollbar-thumb { background: #2a2a2e; border-radius: 2px; }
    .platform-chip {
      display: inline-flex; align-items: center; gap: 5px;
      padding: 5px 11px; border-radius: 20px;
      border: 1px solid rgba(255,255,255,0.07);
      background: rgba(255,255,255,0.04);
      font-family: 'DM Mono', monospace; font-size: 10px;
      color: rgba(255,255,255,0.35); letter-spacing: .04em; transition: all .2s;
    }
    .platform-chip:hover { border-color: rgba(200,169,110,0.3); color: rgba(200,169,110,0.7); background: rgba(200,169,110,0.06); }
    .platform-dot { width:5px; height:5px; border-radius:50%; flex-shrink:0; }
    .tab-btn { background:none; border:none; cursor:pointer; padding:13px 18px; margin-bottom:-1px; font-family:'DM Sans',sans-serif; font-weight:500; font-size:13px; letter-spacing:.01em; text-transform:capitalize; transition:color .15s; }
    .auth-input { flex:1; padding:10px 13px; font-size:13px; background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.08); border-radius:9px; color:#f0ece4; transition:border-color .15s; }
    .auth-input::placeholder { color:rgba(255,255,255,0.2); }
    .auth-input:focus { border-color:rgba(200,169,110,0.4); }
    .beat-row { display:flex; align-items:center; gap:12px; padding:12px 16px; border-radius:11px; border:1px solid rgba(255,255,255,0.06); background:rgba(255,255,255,0.03); transition:background .15s; }
    .beat-row:hover { background:rgba(255,255,255,0.05); }
  </style>
</head>
<body>
<div id="root"></div>
<script type="text/babel">

const SERVER = "https://elegant-youthfulness-production-06ce.up.railway.app";
const GOLD = "#c8a96e", GOLD2 = "#e8c98e";
const DK = "#f0ece4", MD = "rgba(240,236,228,0.6)", SB = "rgba(240,236,228,0.28)";
const RD = "#e06060", GN = "#5ec47a", AM = "#e0a050";
const BDR = "rgba(255,255,255,0.07)";

const PLATFORMS = [
  {name:"Spotify",dot:"#1DB954"},{name:"Apple Music",dot:"#fc3c44"},
  {name:"YouTube",dot:"#FF0000"},{name:"SoundCloud",dot:"#ff5500"},
  {name:"TikTok",dot:"#69C9D0"},{name:"Beatport",dot:"#00C353"},
  {name:"Shazam",dot:"#0088ff"},{name:"ASCAP",dot:"#c8a96e"},
  {name:"BMI",dot:"#c8a96e"},{name:"Splice",dot:"#5b6af0"},
  {name:"Content ID",dot:"#aaaaaa"},
];

function LED({ on, color }) {
  return <div style={{ width:7,height:7,borderRadius:"50%",flexShrink:0,background:on?color:"rgba(255,255,255,0.1)",boxShadow:on?`0 0 8px 2px ${color}88`:"none",transition:"all .3s",animation:on?"pulse 2s ease-in-out infinite":"none" }} />;
}

function Waveform({ hasFile, scanning, tick }) {
  const bars = Array.from({length:52},(_,i)=>
    hasFile ? 10+Math.abs(Math.sin(i*.37+tick*.14))*60+Math.abs(Math.cos(i*.22+tick*.09))*20
            : 4+Math.abs(Math.sin(i*.4))*7
  );
  return (
    <div style={{ position:"relative",height:72,borderRadius:12,background:"rgba(255,255,255,0.03)",border:`1px solid ${BDR}`,overflow:"hidden",display:"flex",alignItems:"center",padding:"0 16px" }}>
      <div style={{ position:"absolute",left:16,right:16,top:"50%",height:1,background:"rgba(255,255,255,0.06)" }} />
      <div style={{ display:"flex",gap:2,alignItems:"center",width:"100%",height:"100%",zIndex:1 }}>
        {bars.map((h,i)=><div key={i} style={{ flex:1,borderRadius:2,height:`${h}%`,background:hasFile?`linear-gradient(180deg,${GOLD2},${GOLD})`:"rgba(255,255,255,0.08)",opacity:hasFile?.5+(i%4)*.13:1,transition:scanning?"height 0.07s":"height 0.8s ease" }} />)}
      </div>
      {scanning && <div style={{ position:"absolute",top:0,bottom:0,left:0,width:"30%",background:`linear-gradient(90deg,transparent,rgba(200,169,110,0.12),transparent)`,animation:"sweep .9s linear infinite",zIndex:2 }} />}
      {!hasFile && <div style={{ position:"absolute",inset:0,display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"'DM Mono',monospace",fontSize:11,color:SB,letterSpacing:".12em",zIndex:3 }}>no audio loaded</div>}
    </div>
  );
}

function MatchCard({ match, index }) {
  return (
    <div style={{ background:"rgba(200,169,110,0.06)",border:`1px solid rgba(200,169,110,0.18)`,borderRadius:14,padding:"16px 18px",animation:`fadeUp .3s ease ${index*.08}s both` }}>
      <div style={{ display:"flex",alignItems:"flex-start",justifyContent:"space-between",gap:12,marginBottom:12 }}>
        <div style={{ flex:1,minWidth:0 }}>
          <div style={{ fontWeight:700,fontSize:16,color:DK,marginBottom:3,letterSpacing:"-.2px" }}>{match.title}</div>
          <div style={{ fontSize:13,color:MD }}>{match.artist}</div>
        </div>
        <div style={{ fontFamily:"'DM Mono',monospace",fontSize:10,color:GOLD,background:`rgba(200,169,110,0.12)`,border:`1px solid rgba(200,169,110,0.25)`,borderRadius:20,padding:"4px 10px",whiteSpace:"nowrap",flexShrink:0 }}>exact match</div>
      </div>
      {match.usages && match.usages.map((u,i)=>(
        <div key={i} style={{ background:"rgba(255,255,255,0.04)",border:`1px solid ${BDR}`,borderRadius:10,padding:"11px 13px",marginBottom:i<match.usages.length-1?8:0 }}>
          <div style={{ display:"flex",alignItems:"center",gap:10 }}>
            <span style={{ fontSize:16,flexShrink:0 }}>{u.icon}</span>
            <div style={{ flex:1,minWidth:0 }}>
              <div style={{ fontWeight:600,fontSize:13,color:DK,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis" }}>{u.work}</div>
              <div style={{ fontSize:11,color:SB,marginTop:2,fontFamily:"'DM Mono',monospace" }}>{u.platform}{u.creator?` · ${u.creator}`:""}{u.date?` · ${u.date}`:""}</div>
            </div>
            <div style={{ fontFamily:"'DM Mono',monospace",fontSize:10,color:GN,background:`rgba(94,196,122,0.1)`,border:`1px solid rgba(94,196,122,0.2)`,borderRadius:20,padding:"3px 9px",flexShrink:0 }}>credited</div>
          </div>
          {u.url && <div style={{ marginTop:8,marginLeft:26 }}><a href={u.url} target="_blank" rel="noreferrer" style={{ fontFamily:"'DM Mono',monospace",fontSize:10,color:GOLD,opacity:.7 }}>listen on {u.platform} ↗</a></div>}
        </div>
      ))}
    </div>
  );
}

function NoMatch() {
  return (
    <div style={{ background:"rgba(94,196,122,0.05)",border:`1px solid rgba(94,196,122,0.15)`,borderRadius:14,padding:"32px 24px",textAlign:"center" }}>
      <div style={{ width:48,height:48,borderRadius:"50%",background:"rgba(94,196,122,0.1)",border:`1px solid rgba(94,196,122,0.2)`,display:"flex",alignItems:"center",justifyContent:"center",margin:"0 auto 14px",fontSize:22 }}>🟢</div>
      <div style={{ fontWeight:700,fontSize:15,color:GN,marginBottom:8 }}>No placements found</div>
      <div style={{ fontSize:13,color:MD,lineHeight:1.7,maxWidth:320,margin:"0 auto" }}>Your beat wasn't detected in any released songs. Monitoring is active — you'll be notified the moment it shows up anywhere.</div>
    </div>
  );
}

function BeatLibrary({ userId, onViewPlacement }) {
  const [beats,    setBeats]    = React.useState([]);
  const [loading,  setLoading]  = React.useState(true);
  const [deleting, setDeleting] = React.useState(null);

  function load() {
    fetch(`${SERVER}/beats/${userId}`)
      .then(r=>r.json())
      .then(d=>{ setBeats(Array.isArray(d)?d:[]); setLoading(false); })
      .catch(()=>setLoading(false));
  }

  React.useEffect(()=>{ load(); },[userId]);

  async function del(id, e) {
    e.stopPropagation();
    setDeleting(id);
    try {
      const r = await fetch(`${SERVER}/beats/${id}`, { method:"DELETE" });
      const d = await r.json();
      if (d.success) setBeats(prev=>prev.filter(b=>b.id!==id));
    } catch(e) { console.error(e); }
    setDeleting(null);
  }

  const sColor = s => s==="placed"?RD:s==="monitoring"?GOLD:AM;
  const sLabel = s => s==="placed"?"placed":s==="monitoring"?"monitoring":"pending";

  if (loading) return <div style={{ textAlign:"center",padding:"40px 0" }}><div style={{ width:20,height:20,border:`2px solid rgba(255,255,255,0.1)`,borderTopColor:GOLD,borderRadius:"50%",animation:"spin .8s linear infinite",margin:"0 auto" }} /></div>;

  if (!beats.length) return (
    <div style={{ textAlign:"center",padding:"48px 0" }}>
      <div style={{ fontSize:28,marginBottom:12,opacity:.15 }}>🎵</div>
      <div style={{ fontSize:14,color:SB }}>No beats submitted yet.</div>
      <div style={{ fontSize:12,color:SB,marginTop:6,opacity:.6 }}>Scanned beats will appear here.</div>
    </div>
  );

  return (
    <div style={{ display:"flex",flexDirection:"column",gap:8,animation:"fadeUp .3s ease both" }}>
      <div style={{ fontFamily:"'DM Mono',monospace",fontSize:9,color:SB,letterSpacing:".14em",textTransform:"uppercase",marginBottom:8 }}>Your beats ({beats.length})</div>
      {beats.map((b,i)=>(
        <div key={b.id} className="beat-row"
          onClick={b.status==="placed"?()=>onViewPlacement(b):undefined}
          style={{ animation:`fadeUp .25s ease ${i*.05}s both`,cursor:b.status==="placed"?"pointer":"default" }}
        >
          <div style={{ width:36,height:36,borderRadius:9,background:"rgba(200,169,110,0.1)",border:`1px solid rgba(200,169,110,0.15)`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:16,flexShrink:0 }}>🎵</div>
          <div style={{ flex:1,minWidth:0 }}>
            <div style={{ fontWeight:600,fontSize:13,color:DK,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis" }}>{b.filename}</div>
            <div style={{ fontFamily:"'DM Mono',monospace",fontSize:10,color:SB,marginTop:3 }}>
              {b.uploaded_at?new Date(b.uploaded_at).toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"}):"—"}
              {b.last_result?` · ${b.last_result}`:""}
            </div>
          </div>
          <div style={{ fontFamily:"'DM Mono',monospace",fontSize:10,color:sColor(b.status),background:`${sColor(b.status)}14`,border:`1px solid ${sColor(b.status)}28`,borderRadius:20,padding:"3px 10px",flexShrink:0 }}>
            {sLabel(b.status)}
          </div>
          {b.status==="placed" && (
            <div style={{ fontFamily:"'DM Mono',monospace",fontSize:10,color:GOLD,opacity:.6,flexShrink:0 }}>view ↗</div>
          )}
          <button onClick={(e)=>del(b.id,e)} disabled={deleting===b.id} title="Remove"
            style={{ width:30,height:30,borderRadius:8,background:"rgba(224,96,96,0.08)",border:"1px solid rgba(224,96,96,0.15)",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,color:RD,fontSize:16,opacity:deleting===b.id?.5:1,transition:"all .15s" }}
            onMouseOver={e=>e.currentTarget.style.background="rgba(224,96,96,0.2)"}
            onMouseOut={e=>e.currentTarget.style.background="rgba(224,96,96,0.08)"}
          >
            {deleting===b.id?<div style={{ width:10,height:10,border:`2px solid rgba(224,96,96,0.3)`,borderTopColor:RD,borderRadius:"50%",animation:"spin .6s linear infinite" }} />:"×"}
          </button>
        </div>
      ))}
    </div>
  );
}

function App() {
  const [user,     setUser]     = React.useState(null);
  const [unVal,    setUnVal]    = React.useState("");
  const [emVal,    setEmVal]    = React.useState("");
  const [pVal,     setPVal]     = React.useState("");
  const [aMode,    setAMode]    = React.useState("in");
  const [aErr,     setAErr]     = React.useState("");
  const [aLoading, setALoading] = React.useState(false);
  const [file,     setFile]     = React.useState(null);
  const [drag,     setDrag]     = React.useState(false);
  const fileRef = React.useRef();
  const [tab,      setTab]      = React.useState("scan");
  const [scanning, setScanning] = React.useState(false);
  const [scanErr,  setScanErr]  = React.useState("");
  const [results,  setResults]  = React.useState(null);
  const [tick,     setTick]     = React.useState(0);
  const refId = React.useRef("");

  React.useEffect(()=>{ if(!scanning)return; const id=setInterval(()=>setTick(t=>t+1),75); return()=>clearInterval(id); },[scanning]);

  async function auth() {
    if (!unVal.trim())                   { setAErr("Username required.");         return; }
    if (pVal.length < 6)                 { setAErr("Password must be 6+ chars."); return; }
    if (aMode==="up" && !emVal.trim())   { setAErr("Email required.");            return; }
    setALoading(true); setAErr("");
    try {
      const endpoint = aMode==="up" ? "/auth/signup" : "/auth/signin";
      const body     = aMode==="up"
        ? { username:unVal.trim(), email:emVal.trim(), password:pVal }
        : { username:unVal.trim(), password:pVal };
      const res  = await fetch(SERVER+endpoint, { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(body) });
      const data = await res.json();
      if (data.error) { setAErr(data.error); }
      else { setUser({ id:data.user.id, email:data.user.email, username:data.user.username, token:data.access_token }); }
    } catch(e) { setAErr("Something went wrong. Try again."); }
    finally { setALoading(false); }
  }

  function pick(f) {
    if (!f) return;
    if (!f.type.startsWith("audio/") && !/\.(mp3|wav|flac|aac|ogg|m4a|aiff)$/i.test(f.name)) { setScanErr("Please upload an audio file."); return; }
    setFile(f); setScanErr(""); setResults(null);
  }

  function viewPlacement(beat) {
    setResults([{
      title: beat.last_result || "Unknown",
      artist: "Previously detected",
      usages: [{ icon:"🎵", work:beat.last_result||"Unknown", platform:"Last scan", creator:"", date:beat.last_scanned?new Date(beat.last_scanned).toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"}):null, url:null }]
    }]);
    refId.current = "PT-LIBRARY";
    setTab("results");
  }

  async function runScan() {
    if (!file||!user||scanning) return;
    setScanning(true); setScanErr(""); setResults(null);
    refId.current = "PT-"+Math.random().toString(36).slice(2,8).toUpperCase();
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("user_id", user.id);
      const res  = await fetch(SERVER+"/scan", { method:"POST", body:form });
      const data = await res.json();
      if (data.error) { setScanErr(data.error); return; }
      const code = data?.status?.code;
      if (code===1001||!data?.metadata?.music?.length) { setResults([]); }
      else if (code!==0) { setScanErr("Scan error: "+(data?.status?.msg||"Unknown")); return; }
      else {
        const matches = data.metadata.music.map(m=>{
          const title=m.title||"Unknown", artist=m.artists?.map(a=>a.name).join(", ")||"Unknown", date=m.release_date||null;
          const usages=[];
          if (m.external_metadata?.spotify?.track?.id)   usages.push({icon:"🎧",work:title,platform:"Spotify",    creator:artist,date,url:`https://open.spotify.com/track/${m.external_metadata.spotify.track.id}`});
          if (m.external_metadata?.youtube?.vid)         usages.push({icon:"▶️",work:title,platform:"YouTube",    creator:artist,date,url:`https://youtube.com/watch?v=${m.external_metadata.youtube.vid}`});
          if (m.external_metadata?.deezer?.track?.id)    usages.push({icon:"🎵",work:title,platform:"Deezer",     creator:artist,date,url:`https://deezer.com/track/${m.external_metadata.deezer.track.id}`});
          if (!usages.length) usages.push({icon:"🎵",work:title,platform:m.label||"Unknown",creator:artist,date,url:null});
          return {title,artist,usages};
        });
        setResults(matches);
      }
      setTab("results");
    } catch(e) { console.error(e); setScanErr("Could not reach server. Please try again."); }
    finally { setScanning(false); }
  }

  const hasResults = results!==null;
  const outColor   = !hasResults?"rgba(255,255,255,0.15)":results.length>0?RD:GN;
  const TABS = user?["scan","results","library","about"]:["scan","results","about"];

  return (
    <div style={{ minHeight:"100vh",background:"#0e0e10",display:"flex",flexDirection:"column",alignItems:"center",padding:"48px 16px 80px" }}>
      <div style={{ position:"fixed",top:0,left:"50%",transform:"translateX(-50%)",width:600,height:300,background:`radial-gradient(ellipse at center,rgba(200,169,110,0.07) 0%,transparent 70%)`,pointerEvents:"none",zIndex:0 }} />
      <div style={{ width:"100%",maxWidth:560,position:"relative",zIndex:1,animation:"fadeUp .5s ease both" }}>

        {/* WORDMARK */}
        <div style={{ textAlign:"center",marginBottom:28 }}>
          <div style={{ fontWeight:700,fontSize:26,color:DK,letterSpacing:"-.5px",marginBottom:4 }}>TrackMy<span style={{ color:GOLD }}>Placements</span></div>

        </div>

        {/* CARD */}
        <div style={{ background:"#16161a",borderRadius:20,border:`1px solid ${BDR}`,overflow:"hidden",boxShadow:"0 32px 80px rgba(0,0,0,0.5),0 2px 0 rgba(255,255,255,0.04) inset" }}>

          {/* HEADER */}
          <div style={{ padding:"18px 24px",borderBottom:`1px solid ${BDR}`,display:"flex",alignItems:"center",justifyContent:"space-between",background:"rgba(255,255,255,0.02)" }}>
            <div style={{ fontFamily:"'DM Mono',monospace",fontSize:10,color:SB,letterSpacing:".14em",textTransform:"uppercase" }}>
              {user?`@${user.username}`:"Placement Location Engine"}
            </div>
            <div style={{ display:"flex",gap:20 }}>
              {[["INPUT",!!file,GOLD],["SEARCH",scanning,AM],["OUTPUT",hasResults,outColor]].map(([label,on,color])=>(
                <div key={label} style={{ display:"flex",flexDirection:"column",alignItems:"center",gap:6 }}>
                  <LED on={on} color={color} />
                  <span style={{ fontFamily:"'DM Mono',monospace",fontSize:8,color:SB,letterSpacing:".12em" }}>{label}</span>
                </div>
              ))}
            </div>
          </div>

          {/* TABS */}
          <div style={{ display:"flex",borderBottom:`1px solid ${BDR}`,paddingLeft:8 }}>
            {TABS.map(t=>(
              <button key={t} className="tab-btn" onClick={()=>setTab(t)} style={{ color:tab===t?GOLD:SB,borderBottom:tab===t?`1.5px solid ${GOLD}`:"1.5px solid transparent" }}>{t}</button>
            ))}
          </div>

          {/* SCAN */}
          {tab==="scan" && (
            <div style={{ padding:"22px 24px 26px" }}>
              <Waveform hasFile={!!file} scanning={scanning} tick={tick} />
              <div onDragOver={e=>{e.preventDefault();setDrag(true);}} onDragLeave={()=>setDrag(false)}
                onDrop={e=>{e.preventDefault();setDrag(false);pick(e.dataTransfer.files[0]);}}
                onClick={()=>fileRef.current.click()}
                style={{ marginTop:12,border:`1.5px dashed ${drag||file?"rgba(200,169,110,0.4)":BDR}`,borderRadius:12,padding:file?"15px 17px":"26px 17px",textAlign:"center",background:file?"rgba(200,169,110,0.04)":"rgba(255,255,255,0.02)",cursor:"pointer",transition:"all .2s" }}
              >
                <input ref={fileRef} type="file" accept="audio/*" style={{display:"none"}} onChange={e=>pick(e.target.files[0])} />
                {file?(
                  <div style={{ display:"flex",alignItems:"center",gap:13,textAlign:"left" }}>
                    <div style={{ width:40,height:40,borderRadius:10,flexShrink:0,background:"rgba(200,169,110,0.12)",border:`1px solid rgba(200,169,110,0.2)`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:18 }}>🎵</div>
                    <div style={{ flex:1,minWidth:0 }}>
                      <div style={{ fontWeight:600,fontSize:13,color:DK,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis" }}>{file.name}</div>
                      <div style={{ fontFamily:"'DM Mono',monospace",fontSize:11,color:SB,marginTop:3 }}>{(file.size/1024).toFixed(1)} KB</div>
                    </div>
                    <span style={{ fontFamily:"'DM Mono',monospace",fontSize:10,color:GOLD,opacity:.7,flexShrink:0 }}>change ↑</span>
                  </div>
                ):(
                  <>
                    <div style={{ fontSize:22,marginBottom:9,opacity:.25 }}>↑</div>
                    <div style={{ fontWeight:500,fontSize:14,color:MD,marginBottom:5 }}>Drop your beat here</div>
                    <div style={{ fontFamily:"'DM Mono',monospace",fontSize:10,color:SB,letterSpacing:".06em" }}>MP3 · WAV · FLAC · AAC · OGG · M4A</div>
                  </>
                )}
              </div>
              {scanErr && <div style={{ marginTop:11,padding:"10px 13px",background:"rgba(224,96,96,0.08)",border:"1px solid rgba(224,96,96,0.2)",borderRadius:9,fontSize:12,color:RD,lineHeight:1.5 }}>{scanErr}</div>}
              <button onClick={runScan} disabled={!file||!user||scanning} style={{ width:"100%",marginTop:16,padding:"15px",border:"none",borderRadius:12,cursor:(!file||!user||scanning)?"not-allowed":"pointer",background:(!file||!user||scanning)?"rgba(255,255,255,0.06)":`linear-gradient(135deg,${GOLD} 0%,${GOLD2} 50%,${GOLD} 100%)`,backgroundSize:"200% auto",color:(!file||!user||scanning)?SB:"#1a1400",fontWeight:700,fontSize:14,letterSpacing:".02em",boxShadow:(!file||!user||scanning)?"none":`0 4px 24px rgba(200,169,110,0.3)`,display:"flex",alignItems:"center",justifyContent:"center",gap:10,animation:scanning?"breathe 1.5s ease-in-out infinite":"none",transition:"all .2s" }}>
                {scanning?<><div style={{ width:14,height:14,border:"2px solid rgba(255,255,255,0.2)",borderTopColor:"rgba(255,255,255,0.7)",borderRadius:"50%",animation:"spin .6s linear infinite" }} /><span style={{ color:MD }}>Scanning…</span></>:!user?<span>Sign in below to scan</span>:<span>Find My Placements</span>}
              </button>
              <div style={{ marginTop:20 }}>
                <div style={{ fontFamily:"'DM Mono',monospace",fontSize:9,color:"rgba(255,255,255,0.18)",letterSpacing:".14em",textTransform:"uppercase",marginBottom:10 }}>Scanned across</div>
                <div style={{ display:"flex",flexWrap:"wrap",gap:6 }}>
                  {PLATFORMS.map(p=><div key={p.name} className="platform-chip"><div className="platform-dot" style={{ background:p.dot }} />{p.name}</div>)}
                </div>
              </div>
            </div>
          )}

          {/* RESULTS */}
          {tab==="results" && (
            <div style={{ padding:"22px 24px 26px" }}>
              {!hasResults?(
                <div style={{ textAlign:"center",padding:"52px 0" }}>
                  <div style={{ fontSize:28,marginBottom:12,opacity:.15 }}>🎵</div>
                  <div style={{ fontSize:14,color:SB }}>No results yet — submit a beat first.</div>
                </div>
              ):(
                <div style={{ animation:"fadeUp .3s ease both" }}>
                  <div style={{ display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:18 }}>
                    <div>
                      <div style={{ fontWeight:700,fontSize:17,color:DK,letterSpacing:"-.3px" }}>{results.length>0?`${results.length} placement${results.length>1?"s":""} found`:"No placements found"}</div>
                      <div style={{ fontFamily:"'DM Mono',monospace",fontSize:10,color:SB,marginTop:4 }}>Ref: {refId.current}</div>
                    </div>
                    <div style={{ width:11,height:11,borderRadius:"50%",background:results.length>0?RD:GN,boxShadow:`0 0 10px 3px ${results.length>0?RD:GN}55`,animation:"pulse 2s ease-in-out infinite" }} />
                  </div>
                  {results.length===0?<NoMatch/>:results.map((m,i)=><MatchCard key={i} match={m} index={i} />)}
                  {results.length>0 && <div style={{ textAlign:"center",padding:"12px 0 4px",fontFamily:"'DM Mono',monospace",fontSize:10,color:SB,letterSpacing:".08em" }}>— all results shown —</div>}
                  <div style={{ marginTop:14,padding:"13px 16px",background:"rgba(200,169,110,0.06)",border:`1px solid rgba(200,169,110,0.14)`,borderRadius:12,display:"flex",gap:11,alignItems:"center" }}>
                    <div style={{ width:7,height:7,borderRadius:"50%",background:GOLD,boxShadow:`0 0 6px 2px ${GOLD}66`,flexShrink:0,animation:"pulse 2s ease-in-out infinite" }} />
                    <div style={{ fontSize:12,color:MD,lineHeight:1.6 }}><span style={{ color:DK,fontWeight:600 }}>Monitoring active.</span> New placements will be flagged for <span style={{ color:GOLD }}>@{user?.username}</span>.</div>
                  </div>
                  <button onClick={()=>{setFile(null);setResults(null);setScanErr("");setTab("scan");}} style={{ width:"100%",padding:"12px",background:"none",border:`1px solid rgba(255,255,255,0.08)`,borderRadius:10,cursor:"pointer",fontWeight:500,fontSize:13,color:SB,transition:"all .15s",marginTop:14 }}
                    onMouseOver={e=>{e.currentTarget.style.borderColor="rgba(200,169,110,0.3)";e.currentTarget.style.color=GOLD;}}
                    onMouseOut={e=>{e.currentTarget.style.borderColor="rgba(255,255,255,0.08)";e.currentTarget.style.color=SB;}}
                  >Check another beat</button>
                </div>
              )}
            </div>
          )}

          {/* LIBRARY */}
          {tab==="library" && user && (
            <div style={{ padding:"22px 24px 26px" }}>
              <BeatLibrary userId={user.id} onViewPlacement={viewPlacement} />
            </div>
          )}

          {/* ABOUT */}
          {tab==="about" && (
            <div style={{ padding:"26px 24px" }}>
              <p style={{ fontSize:14,color:MD,lineHeight:1.8,marginBottom:24 }}>TrackMyPlacements is built for producers. Upload your original beat and we'll instantly scan it across every major streaming platform and content network — showing you exactly where it's been placed and whether you got credited.</p>
              {[["Who it's for","Producers and beatmakers"],["How it works","Upload your beat — we find every song it was placed in"],["Detection","Exact beat match — finds your instrumental under vocals"],["Results","Instant — back in seconds"],["Monitoring","Ongoing — alerts on new placements"],["Coverage","Spotify, Apple Music, YouTube, TikTok & more"],["Formats","MP3, WAV, FLAC, AAC, AIFF, OGG, M4A"],["Cost","Free to start"]].map(([k,v])=>(
                <div key={k} style={{ display:"flex",gap:16,padding:"10px 0",borderBottom:`1px solid ${BDR}` }}>
                  <span style={{ fontFamily:"'DM Mono',monospace",fontSize:11,color:SB,minWidth:100,flexShrink:0 }}>{k}</span>
                  <span style={{ fontSize:13,color:MD }}>{v}</span>
                </div>
              ))}
              {user && <button onClick={()=>setUser(null)} style={{ marginTop:20,padding:"9px 16px",background:"none",border:`1px solid ${BDR}`,borderRadius:8,cursor:"pointer",fontSize:12,color:SB }}>Sign out</button>}
            </div>
          )}

          {/* AUTH STRIP */}
          {!user && (
            <div style={{ borderTop:`1px solid ${BDR}`,background:"rgba(0,0,0,0.2)",padding:"15px 24px 19px" }}>
              <div style={{ display:"flex",gap:16,marginBottom:12,alignItems:"center" }}>
                {[["in","Sign in"],["up","Create account"]].map(([m,label])=>(
                  <button key={m} onClick={()=>{setAMode(m);setAErr("");}} style={{ background:"none",border:"none",cursor:"pointer",padding:"0 0 3px",fontSize:12,fontWeight:600,color:aMode===m?GOLD:SB,borderBottom:aMode===m?`1.5px solid ${GOLD}`:"1.5px solid transparent",transition:"color .15s" }}>{label}</button>
                ))}
                <span style={{ fontFamily:"'DM Mono',monospace",fontSize:10,color:SB,marginLeft:"auto",opacity:.6 }}>free · no card</span>
              </div>
              <div style={{ display:"flex",flexDirection:"column",gap:8 }}>
                <div style={{ display:"flex",gap:8 }}>
                  <input className="auth-input" value={unVal} onChange={e=>setUnVal(e.target.value)} placeholder="Username" onKeyDown={e=>e.key==="Enter"&&auth()} />
                  <input className="auth-input" value={pVal} onChange={e=>setPVal(e.target.value)} placeholder="Password" type="password" onKeyDown={e=>e.key==="Enter"&&auth()} />
                </div>
                {aMode==="up" && (
                  <input className="auth-input" value={emVal} onChange={e=>setEmVal(e.target.value)} placeholder="Email address" type="email" style={{ width:"100%" }} />
                )}
                <button onClick={auth} disabled={aLoading} style={{ padding:"11px",background:`linear-gradient(135deg,${GOLD},${GOLD2})`,border:"none",borderRadius:9,cursor:"pointer",fontWeight:700,fontSize:13,color:"#1a1400",boxShadow:`0 4px 16px rgba(200,169,110,0.25)`,opacity:aLoading?.6:1 }}>
                  {aLoading?"…":aMode==="in"?"Sign in":"Create account"}
                </button>
              </div>
              {aErr && <div style={{ marginTop:9,fontSize:12,color:RD }}>{aErr}</div>}
            </div>
          )}

          <div style={{ height:4,background:`linear-gradient(90deg,transparent,rgba(200,169,110,0.15),transparent)`,borderTop:`1px solid ${BDR}` }} />
        </div>
        <div style={{ marginTop:18,textAlign:"center",fontFamily:"'DM Mono',monospace",fontSize:9,color:"rgba(255,255,255,0.12)",letterSpacing:".2em",textTransform:"uppercase" }}>TrackMyPlacements · Protect Your Sound</div>
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
</script>
</body>
</html>
