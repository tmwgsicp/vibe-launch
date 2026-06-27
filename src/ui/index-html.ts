// vibe-launch 本地操作台（单页，内嵌字符串，随包分发）。
// 设计：苹果哲学落地 —— mono 强调色(近黑/白)、列表优先(hairline divide)、语义 token、
// 零 emoji、克制留白、删比加。围绕 CI/CD 核心：部署 + 历史 + 容器运维 + 隧道。
import { WECHAT_QR, GROUP_QR } from "./qr-assets.js";
export const INDEX_HTML = String.raw`<!doctype html>
<html lang="zh"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>vibe-launch</title>
<style>
  :root{--surface:#fff;--surface-muted:#f5f5f7;--content:#1d1d1f;--muted:#636369;--faint:#9a9aa0;--line:#e4e4e8;
        --accent:#1d1d1f;--accent-content:#fff;--ok:#1f8a3f;--bad:#cf1322;--warn:#a85a00;--field:#fff;}
  :root[data-theme=dark]{--surface:#000;--surface-muted:#161618;--content:#f5f5f7;--muted:#9a9aa0;--faint:#69696f;--line:#2a2a2d;
        --accent:#f5f5f7;--accent-content:#111113;--ok:#32d74b;--bad:#ff453a;--warn:#ff9f0a;--field:#1c1c1e;}
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--surface);color:var(--content);font:14px/1.55 -apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI","PingFang SC",sans-serif;-webkit-font-smoothing:antialiased;transition:background .25s,color .25s}
  .app{display:flex;min-height:100vh}
  .side{width:224px;flex:none;background:var(--surface-muted);border-right:1px solid var(--line);display:flex;flex-direction:column;position:sticky;top:0;height:100vh}
  .logo{padding:24px 22px 18px;font-size:16px;font-weight:600;letter-spacing:-.02em}
  .logo span{color:var(--faint);font-weight:500;font-size:10.5px;margin-left:7px;border:1px solid var(--line);border-radius:5px;padding:1px 5px;vertical-align:1px;letter-spacing:.02em}
  nav{padding:4px 12px;display:flex;flex-direction:column;gap:1px}
  nav a{padding:8px 12px;border-radius:7px;color:var(--muted);font-weight:500;cursor:pointer;font-size:13.5px}
  nav a:hover{color:var(--content)}
  nav a.active{color:var(--content);font-weight:600}
  .foot{margin-top:auto;padding:18px;border-top:1px solid var(--line);font-size:12px;color:var(--muted);display:flex;flex-direction:column;gap:12px}
  .foot .ck{display:flex;align-items:center;gap:8px;cursor:pointer;color:var(--content)}
  .foot .footlink{display:inline-flex;align-items:center;gap:5px;width:fit-content;color:var(--muted);font-weight:500;font-size:12.5px}
  .foot .footlink:hover{color:var(--content)}
  .foot .footlink .ext{color:var(--faint);font-size:11px}
  .foot .priv{display:flex;align-items:center;gap:7px;color:var(--faint);font-size:11.5px}
  .foot .priv .dot{width:5px;height:5px;border-radius:99px;background:var(--ok);flex:none}
  .seg{display:inline-flex;border:1px solid var(--line);border-radius:8px;overflow:hidden;width:fit-content}
  .seg a{padding:5px 13px;cursor:pointer;color:var(--muted);font-size:12.5px}
  .seg a.on{background:var(--accent);color:var(--accent-content)}
  .cfgp{word-break:break-all;color:var(--faint);line-height:1.45}
  main{flex:1;min-width:0}
  .top{display:flex;align-items:baseline;gap:14px;padding:32px 40px 22px;max-width:1160px;margin:0 auto}
  .top h1{font-size:28px;font-weight:600;letter-spacing:-.025em}
  .top .sub{color:var(--muted);font-size:14px}
  .sp{flex:1}
  .content{padding:0 40px 60px;max-width:1160px;margin:0 auto}
  .view{display:none}.view.on{display:block;animation:f .25s ease}
  @keyframes f{from{opacity:0;transform:translateY(4px)}to{opacity:1}}
  h2.sec{font-size:13px;font-weight:600;color:var(--muted);margin:34px 0 6px;letter-spacing:0}
  h2.sec:first-child{margin-top:8px}
  /* 列表（hairline divide，扁平克制） */
  .list{border-top:1px solid var(--line)}
  .row{display:flex;align-items:center;gap:16px;padding:16px 6px;border-bottom:1px solid var(--line);cursor:pointer}
  .row:hover{background:var(--surface-muted)}
  .row .nm{font-weight:600;font-size:15px;min-width:120px;flex:none;letter-spacing:-.01em}
  .row .mt{color:var(--muted);font-size:13px}
  .row .caret{color:var(--faint);font-size:11px;transition:transform .2s}
  .row.open .caret{transform:rotate(90deg)}
  .mini{display:flex;align-items:center;gap:7px;font-size:12px;color:var(--muted);font-variant-numeric:tabular-nums}
  .bar{width:54px;height:5px;background:var(--line);border-radius:99px;overflow:hidden}
  .bar>i{display:block;height:100%;background:var(--content);border-radius:99px;transition:width .4s}
  .bar>i.warn{background:var(--warn)}.bar>i.hot{background:var(--bad)}
  .dot{width:7px;height:7px;border-radius:50%;display:inline-block;flex:none}
  .dot.ok{background:var(--ok)}.dot.bad{background:var(--bad)}.dot.mut{background:var(--faint)}
  .st{display:flex;align-items:center;gap:7px;font-size:13px;color:var(--muted);white-space:nowrap}
  /* 展开详情 */
  .detail{border-bottom:1px solid var(--line);background:var(--surface-muted);padding:18px 6px 22px}
  .detail .grp{margin-bottom:18px}
  .detail .grp:last-child{margin-bottom:0}
  .glabel{font-size:11px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;margin-bottom:9px}
  .metrics{display:flex;flex-direction:column;gap:9px;max-width:340px}
  .metric{display:flex;align-items:center;gap:10px;font-size:12.5px}
  .metric .k{width:34px;color:var(--muted)}
  .metric .bar{width:auto;flex:1}
  .metric .v{font-variant-numeric:tabular-nums;color:var(--content);white-space:nowrap}
  .kv{display:flex;flex-direction:column;gap:6px;font-size:13px;max-width:520px}
  .kv>div{display:flex;gap:12px}
  .kv .kk{color:var(--muted);width:60px;flex:none}
  .kv .vv{color:var(--content);word-break:break-all}
  .citem{display:flex;align-items:center;gap:10px;padding:7px 0;font-size:13px;border-bottom:1px solid var(--line)}
  .citem:last-child{border:none}
  .citem .cn{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px}
  .acts{display:flex;gap:8px;flex-wrap:wrap}
  button{font:inherit;cursor:pointer;border-radius:8px;border:1px solid var(--line);background:transparent;color:var(--content);padding:7px 14px;font-weight:500;transition:.12s}
  button:hover{background:var(--surface-muted);border-color:var(--muted)}
  button.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-content)}
  button.primary:hover{opacity:.88;background:var(--accent)}
  button.sm{padding:4px 11px;font-size:12.5px}
  button:disabled{opacity:.4;cursor:default}
  a.link{color:var(--content);text-decoration:underline;text-underline-offset:2px;cursor:pointer}
  pre.out{margin-top:12px;background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:13px;font-size:12px;max-height:300px;overflow:auto;white-space:pre-wrap;word-break:break-all;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--content)}
  .empty{color:var(--muted);padding:48px 0;text-align:center;font-size:14px}
  .spin{display:inline-block;width:12px;height:12px;border:2px solid var(--line);border-top-color:var(--content);border-radius:50%;animation:s .7s linear infinite;vertical-align:-1px}
  @keyframes s{to{transform:rotate(360deg)}}
  .banner{font-size:14px;color:var(--muted);padding:2px 0 4px}
  .banner b{color:var(--content);font-weight:600}
  .banner.warn b{color:var(--warn)}
  .qrs{display:flex;gap:16px;flex-wrap:wrap;margin-top:10px}
  .qrcard{display:flex;flex-direction:column;align-items:center;gap:11px;padding:16px;border:1px solid var(--line);border-radius:12px;background:var(--surface)}
  .qrcard img{width:158px;height:158px;object-fit:contain;border-radius:6px;cursor:zoom-in;transition:transform .15s;background:#fff}
  .qrcard img:hover{transform:scale(1.04)}
  .qrcap{text-align:center;line-height:1.5}
  .qrzoom{position:fixed;inset:0;background:rgba(0,0,0,.72);display:flex;align-items:center;justify-content:center;z-index:9999;cursor:zoom-out}
  .qrzoom img{max-width:86vw;max-height:86vh;border-radius:12px;background:#fff;padding:10px}
  .hist{font-size:13px;color:var(--muted);display:flex;align-items:center;gap:10px;padding:5px 0}
  .ipmask{cursor:pointer;border-bottom:1px dashed var(--faint);letter-spacing:1px;user-select:none}
  .ipmask:hover{color:var(--content)}
  /* mcp */
  .lead{font-size:17px;line-height:1.6;color:var(--content);max-width:680px;margin:6px 0 8px}
  .lead .mut{color:var(--muted)}
  .tool{padding:14px 6px;border-bottom:1px solid var(--line)}
  .tool .tn{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13.5px;font-weight:600}
  .tool .td{color:var(--muted);font-size:13px;margin-top:3px}
  .code{position:relative;background:var(--surface-muted);border:1px solid var(--line);border-radius:12px;padding:16px 18px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;line-height:1.6;white-space:pre;overflow:auto;color:var(--content)}
  .code .cp{position:absolute;top:10px;right:10px}
  .step{display:flex;gap:12px;margin:14px 0;font-size:14.5px;line-height:1.55;color:var(--content)}
  .step .n{width:22px;height:22px;flex:none;border-radius:50%;border:1px solid var(--line);display:grid;place-items:center;font-size:12px;color:var(--muted)}
  .step code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;color:var(--muted)}
  /* dialog */
  dialog{background:var(--surface);color:var(--content);border:1px solid var(--line);border-radius:16px;padding:0;width:min(520px,93vw);margin:auto;box-shadow:0 24px 60px rgba(0,0,0,.3)}
  dialog::backdrop{background:rgba(0,0,0,.35)}
  dialog.wide{width:min(760px,94vw)}
  .dh{padding:20px 24px 6px;font-weight:600;font-size:19px;letter-spacing:-.01em}
  .dsub{padding:0 24px;color:var(--muted);font-size:13px}
  .db{padding:16px 24px;display:flex;flex-direction:column;gap:14px;max-height:68vh;overflow:auto}
  .df{padding:14px 24px 22px;display:flex;justify-content:flex-end;gap:10px}
  label{display:flex;flex-direction:column;gap:6px;font-size:12.5px;color:var(--muted)}
  input,select,textarea{font:inherit;background:var(--field);border:1px solid var(--line);border-radius:9px;color:var(--content);padding:10px 12px}
  input:focus,select:focus,textarea:focus{outline:none;border-color:var(--muted)}
  .toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:var(--accent);color:var(--accent-content);border-radius:10px;padding:11px 18px;box-shadow:0 10px 30px rgba(0,0,0,.25);z-index:60;max-width:80vw;font-size:13.5px;font-weight:500}
  .toast.err{background:var(--bad);color:#fff}
  .ck{display:inline-flex;align-items:center;gap:7px;cursor:pointer;font-size:13px;color:var(--content);white-space:nowrap}
  .ck input{width:auto}
  /* 日志工具条 + 高亮 */
  .logbar{display:flex;align-items:center;gap:12px;padding:11px 24px;border-bottom:1px solid var(--line);flex-wrap:wrap}
  .logbar #log_filter{flex:1;min-width:150px;padding:7px 11px}
  .logbar select{padding:6px 9px}
  .logbar .live .dot{width:7px;height:7px;border-radius:50%;background:var(--faint)}
  .logbar .live.on .dot{background:var(--ok);animation:pulse 1.4s ease-in-out infinite}
  @keyframes pulse{50%{opacity:.3}}
  #log_body mark{background:var(--warn);color:var(--surface);border-radius:2px;padding:0 1px}
  #log_body .lg-err{color:var(--bad)}
  /* 设置 */
  .setrow{display:flex;align-items:center;gap:16px;padding:16px 6px;border-bottom:1px solid var(--line)}
  .setrow>div:first-child{flex:1}
  .sk{font-weight:600;font-size:15px;letter-spacing:-.01em}
  .sd{color:var(--muted);font-size:13px;margin-top:2px}
  .sw input{width:auto;transform:scale(1.15)}
</style>
<script>(function(){var t;try{t=localStorage.getItem('vl-theme')}catch(e){}if(t!=='light'&&t!=='dark')t=matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';document.documentElement.dataset.theme=t})();</script>
</head>
<body>
<div class="app">
  <aside class="side">
    <div class="logo">vibe-launch<span>v0.7</span></div>
    <nav id="nav">
      <a data-v="overview" class="active">总览</a>
      <a data-v="servers">服务器</a>
      <a data-v="projects">项目</a>
      <a data-v="mcp">MCP</a>
      <a data-v="settings">设置</a>
    </nav>
    <div class="foot">
      <a class="footlink" href="https://github.com/tmwgsicp/vibe-launch" target="_blank" rel="noopener">在 GitHub 查看<span class="ext">↗</span></a>
      <div class="priv"><span class="dot"></span>纯本地 · 仅监听 127.0.0.1 · 无账号</div>
    </div>
  </aside>
  <main>
    <header class="top">
      <h1 id="vtitle">总览</h1><span class="sub" id="vsub"></span>
      <div class="sp"></div>
      <button class="sm" id="refBtn" onclick="refreshAll()">刷新</button>
      <button class="sm primary" id="addBtn"></button>
    </header>
    <div class="content">
      <section class="view on" id="view-overview"></section>
      <section class="view" id="view-servers"></section>
      <section class="view" id="view-projects"></section>
      <section class="view" id="view-mcp"></section>
      <section class="view" id="view-settings"></section>
    </div>
  </main>
</div>

<dialog id="serverDlg"><div class="dh">接入新服务器</div><div class="dsub">自动把专用 key 装到服务器，之后免密直连。</div><div class="db">
  <label>别名<input id="s_alias" placeholder="prod"></label>
  <label>Host / IP<input id="s_host" placeholder="1.2.3.4"></label>
  <label>登录用户<input id="s_user" value="root"></label>
  <label>SSH 端口<input id="s_port" value="22"></label>
  <label>初次登录密码（一次性装公钥用，已有 key 可留空）<input id="s_pw" type="password" placeholder="可留空"></label>
  <label>备注<input id="s_note" placeholder="海外 / 国内"></label>
</div><div class="df"><button onclick="serverDlg.close()">取消</button><button class="primary" id="s_go" onclick="submitServer()">接入</button></div></dialog>

<dialog id="projectDlg"><div class="dh" id="pdlg_title">登记部署项目</div><div class="dsub">登记后可一键部署、看状态。部署命令在服务器上跑。</div><div class="db">
  <label>项目名<input id="p_name" placeholder="myapp"></label>
  <label>部署到哪台服务器<select id="p_server"></select></label>
  <label>部署命令<input id="p_deploy" placeholder="git pull && docker restart myapp-api"></label>
  <label>工作目录（部署前 cd 进来）<span style="display:flex;gap:8px"><input id="p_dir" placeholder="/path/to/app" style="flex:1"><button type="button" class="sm" onclick="openBrowse()">浏览</button></span></label>
  <label>容器名（逗号分隔）<input id="p_containers" placeholder="myapp-api,myapp-web"></label>
  <label>健康检查 URL（逗号分隔）<input id="p_health" placeholder="http://127.0.0.1:8000/health"></label>
</div><div class="df"><button onclick="projectDlg.close()">取消</button><button class="primary" id="p_go" onclick="submitProject()">登记</button></div></dialog>

<dialog id="gitDlg"><div class="dh">转成 git 部署</div><div class="dsub">在服务器上把目录转成 git checkout：装 git、生成只读 deploy key、自动加到仓库、配好免密拉取。</div><div class="db">
  <label>项目<input id="g_proj" disabled></label>
  <label>GitHub 仓库 (owner/repo)<input id="g_repo" placeholder="yourname/yourrepo"></label>
  <label>分支<input id="g_branch" value="main"></label>
  <label style="flex-direction:row;align-items:center;gap:9px"><input type="checkbox" id="g_adopt" style="width:auto"> 目录非空：先备份再转换</label>
</div><div class="df"><button onclick="gitDlg.close()">取消</button><button class="primary" id="g_go" onclick="submitGit()">执行</button></div></dialog>

<dialog id="srvEditDlg"><div class="dh">编辑服务器</div><div class="dsub">改清单里的信息，不会动服务器本身。改别名会自动同步引用它的项目。</div><div class="db">
  <label>别名<input id="se_alias"></label>
  <label>Host / IP<input id="se_host"></label>
  <label>登录用户<input id="se_user"></label>
  <label>SSH 端口<input id="se_port"></label>
  <label>备注<input id="se_note" placeholder="海外 / 国内 / 用途"></label>
</div><div class="df"><button onclick="srvEditDlg.close()">取消</button><button class="primary" id="se_go" onclick="submitSrvEdit()">保存</button></div></dialog>

<dialog id="browseDlg"><div class="dh">选择目录</div><div class="dsub" id="br_cwd"></div><div class="db">
  <div class="acts"><button class="sm" onclick="brGo('PARENT')">↑ 上一级</button></div>
  <div id="br_list" class="list" style="border-top:none"></div>
</div><div class="df"><button onclick="browseDlg.close()">取消</button><button class="primary" onclick="brPick()">选这个目录</button></div></dialog>
<dialog id="ctDlg"><div class="dh" id="ct_title">容器详情</div><div class="dsub" id="ct_sub"></div><div class="db" id="ct_body"></div>
<div class="df"><button onclick="ctDlg.close()">关闭</button></div></dialog>

<dialog id="fileDlg" class="wide"><div class="dh" id="file_title">编辑文件</div><div class="dsub" id="file_sub"></div><div class="db">
  <textarea id="file_body" spellcheck="false" style="width:100%;min-height:44vh;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;line-height:1.5;resize:vertical"></textarea>
</div><div class="df"><button onclick="fileDlg.close()">取消</button><button class="primary" id="file_go" onclick="saveFile()">保存到服务器</button></div></dialog>

<dialog id="fbDlg" class="wide"><div class="dh">项目文件</div><div class="dsub" id="fb_cwd"></div><div class="db">
  <div class="acts"><button class="sm" onclick="fbGo('UP')">↑ 上一级</button><button class="sm" onclick="fbUpload()">上传到此目录</button><input type="file" id="fb_file" style="display:none" onchange="fbDoUpload()"></div>
  <div id="fb_list" class="list" style="border-top:none"></div>
</div><div class="df"><button onclick="fbDlg.close()">关闭</button></div></dialog>

<dialog id="fmDlg" class="wide"><div class="dh">文件管理</div><div class="dsub" id="fm_cwd"></div><div class="db">
  <div class="acts" style="flex-wrap:wrap;gap:8px">
    <button class="sm" onclick="fmUp()">↑ 上一级</button>
    <button class="sm" onclick="fmMkdir()">新建文件夹</button>
    <button class="sm" onclick="fmUpload()">上传到此目录</button>
    <input type="file" id="fm_file" style="display:none" onchange="fmDoUpload()">
    <input id="fm_path" placeholder="跳转到绝对路径…回车" style="padding:6px 10px;font-size:13px;flex:1;min-width:160px" onkeydown="if(event.key==='Enter')fmGoInput()">
  </div>
  <div id="fm_list" class="list" style="border-top:none"></div>
</div><div class="df"><button onclick="fmDlg.close()">关闭</button></div></dialog>

<dialog id="logDlg" class="wide"><div class="dh" id="log_title">容器日志</div>
<div class="logbar">
  <input id="log_filter" placeholder="筛选关键词…" oninput="renderLogs()">
  <label class="ck"><input type="checkbox" id="log_err" onchange="renderLogs()"> 只看错误</label>
  <select id="log_tail" onchange="reloadLogs()"><option value="200">最近 200 行</option><option value="500">500 行</option><option value="1000">1000 行</option><option value="2000">2000 行</option></select>
  <label class="ck live" id="log_livebox"><input type="checkbox" id="log_live" onchange="toggleLive()"><span class="dot"></span>实时</label>
  <span class="sp"></span>
  <span class="mt" id="log_count"></span>
  <button class="sm" onclick="exportLogs()">导出</button>
</div>
<div class="db" style="padding-top:14px"><pre class="out" id="log_body" style="max-height:56vh;margin-top:0">加载中…</pre></div>
<div class="df"><button onclick="closeLogs()">关闭</button></div></dialog>

<script>
const $=id=>document.getElementById(id);
let CONFIG={servers:{},projects:{}},STATUS={},STATS={},MCP=null,TUN=[],HIST={},CTS={},VIEW='overview',EXP=new Set(),HIDEIP=false,REV=new Set(),timer=null;
let THEME='system',AUTOREF=false,AUTOREF_SEC=30,LOG={server:'',container:'',lines:[],es:null};

function toast(m,t){const e=document.createElement('div');e.className='toast '+(t||'');e.textContent=m;document.body.appendChild(e);setTimeout(()=>e.remove(),3000);}
async function api(p,o,ms){ms=ms===undefined?20000:ms;const ac=new AbortController();const t=ms>0?setTimeout(()=>ac.abort(),ms):null;try{const r=await fetch(p,Object.assign({signal:ac.signal},o||{}));const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||('HTTP '+r.status));return d;}catch(e){if(e&&e.name==='AbortError')throw new Error('请求超时（'+Math.round(ms/1000)+'s）—— 服务器无响应');throw e;}finally{if(t)clearTimeout(t);}}
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}
function gb(mb){return mb>=1024?(mb/1024).toFixed(1)+'G':mb+'M';}
function applyTheme(){const eff=THEME==='system'?(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'):THEME;document.documentElement.dataset.theme=eff;}
function setTheme(t){THEME=t;try{localStorage.setItem('vl-theme',t)}catch(e){}applyTheme();if(VIEW==='settings')rSettings();}
function setAutoref(on){AUTOREF=on;try{localStorage.setItem('vl-autoref',on?'1':'0')}catch(e){}applyAutoref();if(VIEW==='settings')rSettings();}
function setIntervalSec(s){AUTOREF_SEC=+s;try{localStorage.setItem('vl-autoref-sec',String(+s))}catch(e){}applyAutoref();if(VIEW==='settings')rSettings();}
function applyAutoref(){if(timer){clearInterval(timer);timer=null;}if(AUTOREF)timer=setInterval(()=>{loadStats();loadStatus().then(render);},AUTOREF_SEC*1000);}
function setHideip(on){HIDEIP=on;try{localStorage.setItem('vl-hideip',on?'1':'')}catch(e){}render();}

document.querySelectorAll('#nav a').forEach(a=>a.onclick=()=>go(a.dataset.v));
function go(v){VIEW=v;
  document.querySelectorAll('#nav a').forEach(a=>a.classList.toggle('active',a.dataset.v===v));
  document.querySelectorAll('.view').forEach(s=>s.classList.toggle('on',s.id==='view-'+v));
  const T={overview:['总览','部署状态一眼概况'],servers:['服务器','接入的机器、指标、隧道'],projects:['项目','部署、历史、容器、转 git'],mcp:['MCP','让 AI 直接调用 vibe-launch'],settings:['设置','外观、行为、关于']};
  $('vtitle').textContent=(T[v]||T.overview)[0];$('vsub').textContent=(T[v]||T.overview)[1];
  $('addBtn').style.display=(v==='servers'||v==='projects')?'':'none';
  $('addBtn').textContent=v==='servers'?'接入服务器':'登记项目';
  $('addBtn').onclick=v==='servers'?openServerDlg:openProjectDlg;
  render();
}

async function loadConfig(){CONFIG=await api('/api/config');}
// 刷新都用 stale-while-revalidate：保留旧数据，新数据到了再静默替换，不闪 spinner。
// 只有从来没加载过（无旧值）时才显示加载态。
async function loadStatus(){try{const a=await api('/api/status');const m={};for(const s of a)m[s.project]=s;STATUS=m;}catch(e){toast(e.message,'err');}}
function loadStats(){for(const n of Object.keys(CONFIG.servers||{})){
  if(!STATS[n])STATS[n]={loading:true};   // 首次才转圈；之后保留旧指标静默刷新
  api('/api/server-stats?server='+encodeURIComponent(n)).then(s=>{STATS[n]=s;render();}).catch(()=>{STATS[n]={reachable:false};render();});}}
async function loadTun(){try{TUN=await api('/api/tunnels');}catch(e){TUN=[];}}
async function loadMcp(){try{MCP=await api('/api/mcp-info');}catch(e){}}
async function refreshAll(){const b=$('refBtn');if(b){b.disabled=true;b.textContent='刷新中…';}
  try{await loadConfig();render();loadStats();await Promise.all([loadStatus(),loadTun()]);
    // 手动刷新时连带刷新当前展开的容器/历史（仍保留旧值，不闪）
    for(const id of EXP){if(id.slice(0,2)==='s:')loadCts(id.slice(2));else if(id.slice(0,2)==='p:')loadHist(id.slice(2));}
    render();}
  finally{if(b){b.disabled=false;b.textContent='刷新';}}}
function render(){({overview:rOverview,servers:rServers,projects:rProjects,mcp:rMcp,settings:rSettings}[VIEW]||rOverview)();}

function mbar(p){p=Math.max(0,Math.min(100,Math.round(p)));const c=p>=90?'hot':(p>=70?'warn':'');return '<div class="bar"><i class="'+c+'" style="width:'+p+'%"></i></div>';}
function stDot(s){if(!s)return '<span class="st"><span class="dot mut"></span>未刷新</span>';
  return s.reachable?'<span class="st"><span class="dot ok"></span>在线'+(s.gitRev?' · '+esc(s.gitRev):'')+'</span>':'<span class="st"><span class="dot bad"></span>连不上</span>';}
function hostHtml(k,v){if(!HIDEIP)return esc(v.host);const sh=REV.has(k);
  return '<span class="ipmask" onclick="event.stopPropagation();revealIp(\''+esc(k)+'\')">'+(sh?esc(v.host):'••••••••')+'</span>';}
function revealIp(k){REV.has(k)?REV.delete(k):REV.add(k);render();}
function toggle(id){EXP.has(id)?EXP.delete(id):EXP.add(id);render();}

/* ---- 总览：紧凑概况 ---- */
function rOverview(){
  const srv=CONFIG.servers||{},prj=CONFIG.projects||{},iss=[];
  Object.entries(STATS).forEach(([n,s])=>{if(!s||s.loading)return;if(!s.reachable){iss.push(n+' 连不上');return;}
    if(s.load&&s.cores&&s.load[0]/s.cores>=.9)iss.push(n+' 负载 '+s.load[0]);
    if(s.memTotalMb&&s.memUsedMb/s.memTotalMb>=.9)iss.push(n+' 内存满');
    if(s.diskTotalMb&&s.diskUsedMb/s.diskTotalMb>=.9)iss.push(n+' 磁盘满');});
  Object.entries(STATUS).forEach(([k,s])=>{if(!s)return;if(!s.reachable){iss.push(k+' 连不上');return;}
    (s.containers||[]).forEach(c=>{if(!/running|up/i.test(c.state))iss.push(k+' '+c.name+' '+c.state);});
    (s.health||[]).forEach(h=>{if(!h.ok)iss.push(k+' 健康 '+h.httpCode);});});
  let h=iss.length?'<div class="banner warn"><b>'+iss.length+' 项需注意</b> · '+iss.map(esc).join(' · ')+'</div>':'<div class="banner"><b>一切正常</b></div>';
  h+='<h2 class="sec">服务器</h2><div class="list">';
  h+=Object.keys(srv).map(n=>{const s=STATS[n];let m='';
    if(s&&s.loading)m='<span class="mt"><span class="spin"></span></span>';
    else if(s&&!s.reachable)m='<span class="st"><span class="dot bad"></span>连不上</span>';
    else if(s){const p=[];if(s.load&&s.cores)p.push('<div class="mini">负载 '+mbar(s.load[0]/s.cores*100)+'</div>');
      if(s.memTotalMb)p.push('<div class="mini">内存 '+mbar(s.memUsedMb/s.memTotalMb*100)+'</div>');
      if(s.diskTotalMb)p.push('<div class="mini">磁盘 '+mbar(s.diskUsedMb/s.diskTotalMb*100)+'</div>');m=p.join('');}
    return '<div class="row" style="cursor:default"><span class="nm">'+esc(n)+'</span>'+m+'<span class="sp"></span><span class="mt">'+(s&&s.containersTotal!=null?'容器 '+s.containersRunning+'/'+s.containersTotal:'')+'</span></div>';
  }).join('')||'<div class="empty">还没有服务器</div>';
  h+='</div><h2 class="sec">项目</h2><div class="list">';
  h+=Object.keys(prj).map(k=>{const s=STATUS[k];let info='';
    if(s&&s.reachable){const c=(s.containers||[]).map(x=>'<span class="dot '+(/running|up/i.test(x.state)?'ok':'bad')+'"></span>').join(' ');
      info='<span class="mini">'+c+'</span>';}
    return '<div class="row" style="cursor:default"><span class="nm">'+esc(k)+'</span><span class="mt">'+esc(prj[k].server)+'</span>'+info+'<span class="sp"></span>'+stDot(s)+'</div>';
  }).join('')||'<div class="empty">还没有项目</div>';
  $('view-overview').innerHTML=h+'</div>';
}

/* ---- 服务器：列表 + 展开(指标 + 隧道) ---- */
function rServers(){
  const ks=Object.keys(CONFIG.servers||{});
  if(!ks.length){$('view-servers').innerHTML='<div class="empty">还没有服务器。点右上"接入服务器"。</div>';return;}
  $('view-servers').innerHTML='<div class="list">'+ks.map(srvRow).join('')+'</div>';
}
function srvRow(k){const v=CONFIG.servers[k],s=STATS[k],op=EXP.has('s:'+k);
  let mini='';
  if(s&&s.loading)mini='<span class="mt"><span class="spin"></span></span>';
  else if(s&&!s.reachable)mini='<span class="st"><span class="dot bad"></span>连不上</span>';
  else if(s){const p=[];if(s.load&&s.cores)p.push('<div class="mini">负载 '+mbar(s.load[0]/s.cores*100)+'</div>');
    if(s.memTotalMb)p.push('<div class="mini">内存 '+mbar(s.memUsedMb/s.memTotalMb*100)+'</div>');
    if(s.diskTotalMb)p.push('<div class="mini">磁盘 '+mbar(s.diskUsedMb/s.diskTotalMb*100)+'</div>');mini=p.join('');}
  let row='<div class="row '+(op?'open':'')+'" onclick="toggle(\'s:'+esc(k)+'\')"><span class="nm">'+esc(k)+'</span>'
    +'<span class="mt">'+esc(v.user)+'@'+hostHtml(k,v)+(v.port&&v.port!=22?':'+v.port:'')+'</span>'
    +(v.note?'<span class="mt" style="color:var(--faint)">'+esc(v.note)+'</span>':'')+mini
    +'<span class="sp"></span><span class="caret">▸</span></div>';
  if(!op)return row;
  let d='<div class="detail">';
  if(s&&s.reachable){d+='<div class="grp"><div class="glabel">系统指标</div><div class="metrics">';
    const mt=(k2,p,v2)=>'<div class="metric"><span class="k">'+k2+'</span>'+mbar(p)+'<span class="v">'+v2+'</span></div>';
    if(s.memTotalMb)d+=mt('内存',s.memUsedMb/s.memTotalMb*100,gb(s.memUsedMb)+' / '+gb(s.memTotalMb));
    if(s.diskTotalMb)d+=mt('磁盘',s.diskUsedMb/s.diskTotalMb*100,gb(s.diskUsedMb)+' / '+gb(s.diskTotalMb));
    if(s.load&&s.cores)d+=mt('负载',s.load[0]/s.cores*100,s.load.join(' ')+' · '+s.cores+'核');
    d+='</div></div>';
    const info=[];
    if(s.os)info.push(['系统',s.os]);
    if(s.kernel)info.push(['内核',s.kernel]);
    if(s.arch)info.push(['架构',s.arch]);
    if(s.cpuModel)info.push(['CPU',s.cpuModel+(s.cores?' · '+s.cores+' 核':'')]);
    else if(s.cores)info.push(['CPU',s.cores+' 核']);
    if(s.dockerVer)info.push(['Docker','v'+s.dockerVer+(s.containersTotal!=null?' · 容器 '+s.containersRunning+'/'+s.containersTotal:'')]);
    if(s.hostname)info.push(['主机名',s.hostname]);
    if(s.uptime)info.push(['运行',s.uptime]);
    if(info.length)d+='<div class="grp"><div class="glabel">主机信息</div><div class="kv">'+info.map(x=>'<div><span class="kk">'+x[0]+'</span><span class="vv">'+esc(x[1])+'</span></div>').join('')+'</div></div>';
  }
  // 隧道
  const my=TUN.filter(t=>t.target===k);
  d+='<div class="grp"><div class="glabel">隧道（关掉公网 DB 端口后用它连库）</div>';
  d+='<div class="acts">'
    +'<button class="sm" onclick="event.stopPropagation();startTun(\''+esc(k)+'\',\'pg\')">PG</button>'
    +'<button class="sm" onclick="event.stopPropagation();startTun(\''+esc(k)+'\',\'mysql\')">MySQL</button>'
    +'<button class="sm" onclick="event.stopPropagation();startTun(\''+esc(k)+'\',\'mongo\')">MongoDB</button>'
    +'<button class="sm" onclick="event.stopPropagation();startTun(\''+esc(k)+'\',\'redis\')">Redis</button>'
    +'<button class="sm" onclick="event.stopPropagation();startTun(\''+esc(k)+'\',\'mssql\')">SQL Server</button>'
    +'<button class="sm" onclick="event.stopPropagation();startTunCustom(\''+esc(k)+'\')">自定义端口…</button></div>';
  if(my.length)d+='<div style="margin-top:10px">'+my.map(t=>'<div class="hist"><span class="dot ok"></span>localhost:'+t.localPort+' → 内网 '+t.remoteHost+':'+t.remotePort+'　<a class="link" onclick="event.stopPropagation();stopTun(\''+esc(t.id)+'\')">关闭</a></div>').join('')+'</div>';
  d+='</div>';
  // 端口暴露检测
  d+='<div class="grp"><div class="glabel">数据库端口暴露</div><div class="acts"><button class="sm" onclick="event.stopPropagation();checkPorts(\''+esc(k)+'\')">检测公网可达</button></div><div class="mt" id="ports-'+esc(k)+'" style="margin-top:9px"></div></div>';
  // 容器管理（列全部 + 删停止 + 一键清理）
  d+='<div class="grp"><div class="glabel">容器管理　<a class="link" onclick="event.stopPropagation();loadCts(\''+esc(k)+'\')">刷新</a></div>'
    +'<div class="acts"><button class="sm" onclick="event.stopPropagation();pruneCts(\''+esc(k)+'\')">清理停止容器</button></div>'
    +'<div id="cts-'+esc(k)+'" style="margin-top:9px">'+ctsHtml(k)+'</div></div>';
  // 文件管理（全盘，任意路径）
  d+='<div class="grp"><div class="glabel">文件管理</div><div class="acts"><button class="sm" onclick="event.stopPropagation();openFm(\''+esc(k)+'\',\'\')">打开文件管理器</button></div>'
    +'<div class="mt" style="margin-top:6px;color:var(--faint)">浏览/上传/下载/编辑/重命名/删除，可在服务器任意路径操作</div></div>';
  // 管理
  d+='<div class="grp"><div class="acts"><button class="sm" onclick="event.stopPropagation();openSrvEdit(\''+esc(k)+'\')">编辑</button><button class="sm" onclick="event.stopPropagation();delServer(\''+esc(k)+'\')">删除</button></div></div>';
  if(!CTS[k])setTimeout(()=>loadCts(k),0);
  return row+d+'</div>';
}

/* ---- 项目：列表 + 展开(部署/历史/容器/git) ---- */
function rProjects(){
  const ks=Object.keys(CONFIG.projects||{});
  if(!ks.length){$('view-projects').innerHTML='<div class="empty">还没有项目。点右上"登记项目"。</div>';return;}
  $('view-projects').innerHTML='<div class="list">'+ks.map(prjRow).join('')+'</div>';
}
function prjRow(k){const p=CONFIG.projects[k],s=STATUS[k],op=EXP.has('p:'+k);
  let info='';if(s&&s.reachable){const c=(s.containers||[]).map(x=>'<span class="dot '+(/running|up/i.test(x.state)?'ok':'bad')+'"></span>').join(' ');info='<span class="mini">'+c+'</span>';}
  let row='<div class="row '+(op?'open':'')+'" onclick="toggle(\'p:'+esc(k)+'\')"><span class="nm">'+esc(k)+'</span>'
    +'<span class="mt">'+esc(p.server)+'</span>'+info+'<span class="sp"></span>'+stDot(s)+'<span class="caret">▸</span></div>';
  if(!op)return row;
  let d='<div class="detail">';
  // 部署配置（让原理可见：服务器目录 + 部署命令 + 是否 git 接管）
  const cfg=[['目录',p.dir||'(未配)'],['部署命令',p.deploy||'(未配)']];
  if(s&&s.gitRepo)cfg.push(['代码仓库',s.gitRepo]);
  cfg.push(['Git 接管',(s&&s.gitRepo)?('是 · '+(s.gitBranch||'')+(s.gitRev?' @ '+s.gitRev:'')):'否（点"转 git"接管后可自动拉代码）']);
  d+='<div class="grp"><div class="glabel">部署配置</div><div class="kv">'+cfg.map(x=>'<div><span class="kk">'+x[0]+'</span><span class="vv">'+esc(x[1])+'</span></div>').join('')+'</div></div>';
  // 操作
  d+='<div class="grp"><div class="acts"><button class="primary sm" onclick="event.stopPropagation();doDeploy(\''+esc(k)+'\')">部署</button>'
    +'<button class="sm" onclick="event.stopPropagation();doPredeploy(\''+esc(k)+'\')">看更新</button>'
    +'<button class="sm" onclick="event.stopPropagation();doStatus(\''+esc(k)+'\')">刷新状态</button>'
    +'<button class="sm" onclick="event.stopPropagation();openGit(\''+esc(k)+'\')">转 git</button></div><div id="out-'+esc(k)+'"></div></div>';
  // 健康
  if(s&&s.reachable&&s.health&&s.health.length)d+='<div class="grp"><div class="glabel">健康检查</div>'+s.health.map(h=>'<div class="hist"><span class="dot '+(h.ok?'ok':'bad')+'"></span>'+esc(h.url.replace(/^https?:\/\//,''))+' · '+h.httpCode+'</div>').join('')+'</div>';
  // 容器（日志/重启/停止/启动/详情）
  if(p.containers&&p.containers.length){d+='<div class="grp"><div class="glabel">容器</div>';
    d+=p.containers.map(cn=>{const st=(s&&s.containers||[]).find(x=>x.name===cn);const run=st&&/running|up/i.test(st.state);
      return '<div class="citem"><span class="dot '+(run?'ok':'bad')+'"></span><span class="cn">'+esc(cn)+'</span><span class="mt">'+(st?esc(st.state):'')+'</span><span class="sp"></span>'
        +'<button class="sm" onclick="event.stopPropagation();showLogs(\''+esc(p.server)+'\',\''+esc(cn)+'\')">日志</button>'
        +(run?'<button class="sm" onclick="event.stopPropagation();restartC(\''+esc(p.server)+'\',\''+esc(cn)+'\')">重启</button><button class="sm" onclick="event.stopPropagation();stopC(\''+esc(p.server)+'\',\''+esc(cn)+'\')">停止</button>':'<button class="sm" onclick="event.stopPropagation();startC(\''+esc(p.server)+'\',\''+esc(cn)+'\')">启动</button>')
        +'<button class="sm" onclick="event.stopPropagation();inspectC(\''+esc(p.server)+'\',\''+esc(cn)+'\')">详情</button></div>';
    }).join('');d+='</div>';}
  // 配置文件 / .env（读写锁在项目目录树内，保存前自动备份 .vlbak）
  d+='<div class="grp"><div class="glabel">项目文件 / .env</div><div class="acts">'
    +'<button class="sm" onclick="event.stopPropagation();openFb(\''+esc(k)+'\')">浏览文件</button>'
    +'<input id="fpath-'+esc(k)+'" value=".env" style="padding:6px 10px;font-size:13px;width:170px" onclick="event.stopPropagation()">'
    +'<button class="sm" onclick="event.stopPropagation();openFile(\''+esc(k)+'\')">直接打开</button>'
    +(p.dir?'<button class="sm" onclick="event.stopPropagation();openFm(\''+esc(p.server)+'\',\''+je(p.dir)+'\')">全盘文件管理器</button>':'')+'</div>'
    +'<div class="mt" style="margin-top:6px;color:var(--faint)">「浏览文件」锁在项目目录内（自动备份 .vlbak）；「全盘文件管理器」可在服务器任意路径操作</div></div>';
  // 部署历史
  d+='<div class="grp"><div class="glabel">部署历史</div><div id="hist-'+esc(k)+'">'+histHtml(k)+'</div></div>';
  // 管理
  d+='<div class="grp"><div class="acts"><button class="sm" onclick="event.stopPropagation();openPrjEdit(\''+esc(k)+'\')">编辑</button><button class="sm" onclick="event.stopPropagation();delProject(\''+esc(k)+'\')">删除</button></div></div>';
  if(!HIST[k])setTimeout(()=>loadHist(k),0);
  return row+d+'</div>';
}
function histHtml(k){const a=HIST[k];if(!a)return '<span class="mt">加载中…</span>';
  return a.length?a.map(r=>'<div class="hist"><span class="dot '+(r.success?'ok':'bad')+'"></span>'+(r.action==='rollback'?'↩ 回滚':'部署')+' · '+new Date(r.ts).toLocaleString()+(r.gitRev?' · '+esc(r.gitRev):'')+(r.error?' · '+esc(r.error).slice(0,28):'')+(r.gitRev?'　<a class="link" onclick="event.stopPropagation();doRollback(\''+esc(k)+'\',\''+esc(r.gitRev)+'\')">回滚到此</a>':'')+'</div>').join(''):'<span class="mt">还没有部署记录</span>';}
async function loadHist(k){try{HIST[k]=await api('/api/history?project='+encodeURIComponent(k));}catch(e){if(!HIST[k])HIST[k]=[];}render();}
async function doRollback(k,rev){if(!confirm('把 '+k+' 回滚到 '+rev+'？\n会 git reset --hard 到该版本并重启容器（不跑部署命令）。'))return;
  const out=$('out-'+k);if(out)out.innerHTML='<pre class="out"><span class="spin"></span> 回滚中…</pre>';
  try{const r=await api('/api/rollback/'+encodeURIComponent(k),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({rev})},0);
    if(out)out.innerHTML='<pre class="out">'+(r.success?'回滚成功':'回滚完成（有问题）')+(r.gitRev?' @'+esc(r.gitRev):'')+'\n'+esc(r.output||'')+(r.error?'\n'+esc(r.error):'')+'</pre>';
    toast(k+(r.success?' 已回滚':' 回滚有问题'),r.success?'':'err');await doStatus(k);loadHist(k);
  }catch(e){if(out)out.innerHTML='<pre class="out">'+esc(e.message)+'</pre>';toast(e.message,'err');}}

/* ---- MCP ---- */
function rMcp(){
  let h='<div class="lead">在 AI 里说一句话就部署。<span class="mut">vibe-launch 通过 MCP 协议接入 Claude Code / Cursor / Codex，配好后你对 AI 说"部署 wechatrss"，它就调用下面的工具替你完成。</span></div>';
  h+='<h2 class="sec">暴露的工具'+(MCP?'（'+MCP.tools.length+'）':'')+'</h2><div class="list">';
  h+=MCP?MCP.tools.map(t=>'<div class="tool"><div class="tn">'+esc(t.name)+'</div><div class="td">'+esc(t.desc)+'</div></div>').join(''):'<span class="mt">加载中…</span>';
  h+='</div><h2 class="sec">接入 AI 客户端</h2>';
  h+='<div class="step"><div class="n">1</div><div>把下面配置加进客户端 MCP 设置（Claude Code 在 <code>~/.claude.json</code>，Cursor 在设置里）</div></div>';
  h+='<div class="code"><button class="sm cp" onclick="copyCfg()">复制</button>'+esc(MCP?JSON.stringify(MCP.config,null,2):'{}')+'</div>';
  h+='<div class="step" style="margin-top:18px"><div class="n">2</div><div>重启客户端，对 AI 说"用 vibe-launch 部署 X"即可。</div></div>';
  $('view-mcp').innerHTML=h;
}
function copyCfg(){if(MCP)navigator.clipboard.writeText(JSON.stringify(MCP.config,null,2)).then(()=>toast('已复制'));}

/* ---- 设置 ---- */
function rSettings(){
  const seg=(opts,cur,fn)=>'<div class="seg">'+opts.map(o=>'<a class="'+(o[0]===cur?'on':'')+'" onclick="'+fn+'(\''+o[0]+'\')">'+o[1]+'</a>').join('')+'</div>';
  const sw=(on,fn)=>'<label class="sw"><input type="checkbox" '+(on?'checked':'')+' onchange="'+fn+'(this.checked)"></label>';
  const row=(k,d,ctrl)=>'<div class="setrow"><div><div class="sk">'+k+'</div>'+(d?'<div class="sd">'+d+'</div>':'')+'</div>'+ctrl+'</div>';
  let h='<h2 class="sec">外观</h2>';
  h+=row('主题','浅色 / 深色 / 跟随系统',seg([['light','浅色'],['dark','深色'],['system','跟随系统']],THEME,'setTheme'));
  h+='<h2 class="sec">行为</h2>';
  h+=row('自动刷新','定时拉取服务器指标与项目状态',sw(AUTOREF,'setAutoref'));
  if(AUTOREF)h+=row('刷新间隔','',seg([['15','15 秒'],['30','30 秒'],['60','60 秒']],String(AUTOREF_SEC),'setIntervalSec'));
  h+=row('隐藏服务器 IP','列表里打码，点击单独显示',sw(HIDEIP,'setHideip'));
  h+='<h2 class="sec">关于</h2>';
  h+=row('vibe-launch 0.7','纯本地操作台 · 只监听 127.0.0.1 · 无账号','');
  h+=row('配置文件','<span class="cfgp">'+esc(CONFIG._path||'')+'</span>','');
  h+='<h2 class="sec">联系与交流</h2>';
  const qr=(src,title,sub)=>'<figure class="qrcard"><img src="'+src+'" alt="'+title+'" onclick="qrZoom(this.src)">'
    +'<figcaption class="qrcap"><div class="sk">'+title+'</div><div class="sd">'+sub+'</div></figcaption></figure>';
  h+='<div class="qrs">'+qr('${WECHAT_QR}','个人微信','技术交流 · 商务合作')+qr('${GROUP_QR}','vibecoding 交流群','扫码加入')+'</div>';
  $('view-settings').innerHTML=h;
}
function qrZoom(src){const o=document.createElement('div');o.className='qrzoom';o.onclick=()=>o.remove();
  const img=document.createElement('img');img.src=src;o.appendChild(img);document.body.appendChild(o);
}

/* ---- 操作 ---- */
async function doStatus(k){try{const a=await api('/api/status?project='+encodeURIComponent(k));STATUS[k]=a[0];render();}catch(e){toast(e.message,'err');}}
async function doDeploy(k){const out=$('out-'+k);if(out)out.innerHTML='<pre class="out"><span class="spin"></span> 部署中…</pre>';
  try{const r=await api('/api/deploy/'+encodeURIComponent(k),{method:'POST'},0);
    if(out){let html='<pre class="out">'+(r.success?'成功':'失败')+(r.gitRev?' @'+esc(r.gitRev):'')+'\n'+esc(r.output||'')+(r.error?'\n'+esc(r.error):'')+'</pre>';
      if(r.failLogs&&r.failLogs.length)html+=r.failLogs.map(f=>'<div class="glabel" style="margin-top:10px">'+esc(f.container)+' · 最后日志</div><pre class="out" style="margin-top:6px">'+esc(f.logs||'(空)')+'</pre>').join('');
      out.innerHTML=html;}
    toast(k+(r.success?' 部署成功':' 部署失败'),r.success?'':'err');await Promise.all([doStatus(k),0]);loadHist(k);
  }catch(e){if(out)out.innerHTML='<pre class="out">'+esc(e.message)+'</pre>';toast(e.message,'err');}}
async function doPredeploy(k){const out=$('out-'+k);if(out)out.innerHTML='<pre class="out"><span class="spin"></span> 拉取远端…</pre>';
  try{const r=await api('/api/predeploy?project='+encodeURIComponent(k),undefined,60000);
    if(r.error){out.innerHTML='<pre class="out">'+esc(r.error)+'</pre>';return;}
    if(!r.incoming.length){out.innerHTML='<pre class="out">已是最新，无待部署的新提交（当前 '+esc(r.gitRev||'?')+(r.branch?' @ '+esc(r.branch):'')+'）</pre>';return;}
    out.innerHTML='<div class="glabel" style="margin-top:10px">将拉取 '+r.incoming.length+' 个新提交（'+esc(r.branch||'')+'）</div>'+r.incoming.map(c=>'<div class="hist"><span class="cn" style="color:var(--muted)">'+esc(c.rev)+'</span>&nbsp;'+esc(c.subject)+'</div>').join('');
  }catch(e){out.innerHTML='<pre class="out">'+esc(e.message)+'</pre>';}}
async function checkPorts(k){const el=$('ports-'+k);if(!el)return;el.innerHTML='<span class="spin"></span> 探测中（约 3 秒）…';
  try{const r=await api('/api/port-exposure?server='+encodeURIComponent(k));
    const present=r.services.filter(s=>s.present),exposed=present.filter(s=>s.reachable);
    if(!present.length){el.innerHTML='<div class="hist"><span class="dot ok"></span>没检测到常见数据库在监听（PG/Redis/MySQL/Mongo）</div>';return;}
    let h=present.map(s=>{const dot=s.reachable?'bad':(s.bind==='public'?'mut':'ok');
      const how=s.mode==='container'?('容器'+(s.container?' '+esc(s.container):'')):(s.mode==='native'?'原生':'监听中');
      const bind=s.bind==='local'?'仅本地':'公网 0.0.0.0';const reach=s.reachable?'外网可达':'外网不可达';
      return '<div class="hist"><span class="dot '+dot+'"></span><b>'+esc(s.service)+':'+s.port+'</b> · '+how+' · 监听 '+bind+' · '+reach+'　<a class="link" onclick="event.stopPropagation();startTunPort(\''+esc(k)+'\','+s.port+')">开隧道</a></div>';}).join('');
    if(exposed.length){const hasC=exposed.some(s=>s.mode==='container'),hasN=exposed.some(s=>s.mode==='native');
      h+='<div class="mt" style="margin-top:8px;color:var(--bad)"><b>'+exposed.map(s=>esc(s.service)).join('、')+' 正对公网开放</b></div>';
      h+='<div class="mt" style="margin-top:3px">① 改走隧道：上面「开 '+exposed.map(s=>esc(s.service)).join('/')+' 隧道」连本地。② 关闭暴露：</div>';
      if(hasC)h+='<div class="mt">· 容器：端口映射改成 <span class="cn">127.0.0.1:端口</span>（1Panel 里编辑容器端口 / compose 改 ports）后重建。</div>';
      if(hasN)h+='<div class="mt">· 原生：配置只监听本地（postgresql.conf listen_addresses=localhost / redis.conf bind 127.0.0.1）后重启。</div>';
      h+='<div class="mt">· 再到云安全组关掉这些端口公网入站（这步工具不代改）。</div>';}
    el.innerHTML=h;
  }catch(e){el.textContent='探测失败：'+e.message;}}
const LOG_ER=/error|exception|traceback|fail|fatal|panic|critical|\berr\b/i;
function showLogs(sv,cn){if(LOG.es){LOG.es.close();}LOG={server:sv,container:cn,lines:[],es:null};
  $('log_title').textContent=cn+' · 日志';$('log_filter').value='';$('log_err').checked=false;$('log_live').checked=false;$('log_livebox').classList.remove('on');
  $('log_body').textContent='加载中…';$('log_count').textContent='';logDlg.showModal();reloadLogs();}
async function reloadLogs(){if($('log_live').checked)return;
  try{const r=await api('/api/container-logs?server='+encodeURIComponent(LOG.server)+'&container='+encodeURIComponent(LOG.container)+'&tail='+$('log_tail').value);
    LOG.lines=(r.logs||'').split(/\r?\n/).filter(x=>x.length);renderLogs();}catch(e){$('log_body').textContent='失败：'+e.message;}}
function renderLogs(){const f=$('log_filter').value.trim(),fl=f.toLowerCase(),eo=$('log_err').checked;
  const shown=LOG.lines.filter(l=>{if(eo&&!LOG_ER.test(l))return false;if(fl&&l.toLowerCase().indexOf(fl)<0)return false;return true;});
  const re=f?new RegExp('('+f.replace(/[.*+?^{}$()|[\]\\]/g,'\\$&')+')','ig'):null;
  $('log_body').innerHTML=shown.length?shown.map(l=>{let s=esc(l);if(re)s=s.replace(re,'<mark>$1</mark>');return LOG_ER.test(l)?'<span class="lg-err">'+s+'</span>':s;}).join('\n'):'<span class="mt">无匹配行</span>';
  $('log_count').textContent=shown.length+(shown.length!==LOG.lines.length?' / '+LOG.lines.length:'')+' 行';
  if($('log_live').checked)$('log_body').scrollTop=$('log_body').scrollHeight;}
function toggleLive(){const on=$('log_live').checked;$('log_livebox').classList.toggle('on',on);
  if(on){LOG.lines=[];renderLogs();
    const es=new EventSource('/api/container-logs/stream?server='+encodeURIComponent(LOG.server)+'&container='+encodeURIComponent(LOG.container)+'&tail='+$('log_tail').value);
    es.onmessage=e=>{LOG.lines.push(e.data);if(LOG.lines.length>5000)LOG.lines=LOG.lines.slice(-5000);renderLogs();};LOG.es=es;
  }else{if(LOG.es){LOG.es.close();LOG.es=null;}reloadLogs();}}
function exportLogs(){const blob=new Blob([LOG.lines.join('\n')],{type:'text/plain;charset=utf-8'});
  const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=LOG.container+'-'+new Date().toISOString().slice(0,19).replace(/[:T]/g,'')+'.log';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),3000);toast('已导出 '+LOG.lines.length+' 行');}
function closeLogs(){if(LOG.es){LOG.es.close();LOG.es=null;}logDlg.close();}
async function restartC(sv,cn){if(!confirm('重启容器 '+cn+'？'))return;
  try{const r=await api('/api/container-restart',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({server:sv,container:cn})});toast(r.ok?(cn+' 已重启'):'重启失败',r.ok?'':'err');}catch(e){toast(e.message,'err');}}
async function startC(sv,cn){
  try{await api('/api/container-start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({server:sv,container:cn})});toast(cn+' 已启动');loadCts(sv);loadStats();loadStatus().then(render);}catch(e){toast(e.message,'err');}}
async function stopC(sv,cn){if(!confirm('停止容器 '+cn+'？\n会停掉这个运行中的服务。'))return;
  try{await api('/api/container-stop',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({server:sv,container:cn})});toast(cn+' 已停止');loadCts(sv);loadStats();loadStatus().then(render);}catch(e){toast(e.message,'err');}}
async function inspectC(sv,cn){$('ct_title').textContent=cn;$('ct_sub').textContent=sv;$('ct_body').innerHTML='<span class="mt"><span class="spin"></span> 加载中…</span>';ctDlg.showModal();
  try{const d=await api('/api/container-inspect?server='+encodeURIComponent(sv)+'&container='+encodeURIComponent(cn),undefined,30000);
    const sa=d.startedAt&&!String(d.startedAt).startsWith('0001')?new Date(d.startedAt).toLocaleString():'—';
    const kv=[['镜像',d.image],['状态',d.state],['健康',d.health],['重启次数',d.restartCount],['创建',d.created?new Date(d.created).toLocaleString():'—'],['最近启动',sa],['容器 IP',d.ip||'—'],['启动命令',d.command||'—']];
    let h='<div class="kv">'+kv.map(x=>'<div><span class="kk">'+esc(x[0])+'</span><span class="vv">'+esc(String(x[1]))+'</span></div>').join('')+'</div>';
    h+='<div class="glabel" style="margin-top:14px">端口映射</div>'+(d.ports&&d.ports.length?d.ports.map(p=>'<div class="hist">'+esc(p)+'</div>').join(''):'<span class="mt">无</span>');
    h+='<div class="glabel" style="margin-top:14px">挂载</div>'+(d.mounts&&d.mounts.length?d.mounts.map(m=>'<div class="hist" style="word-break:break-all">'+esc(m)+'</div>').join(''):'<span class="mt">无</span>');
    $('ct_body').innerHTML=h;
  }catch(e){$('ct_body').innerHTML='<span class="mt">'+esc(e.message)+'</span>';}}
async function startTun(target,svc){try{const r=await api('/api/tunnel/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({target,service:svc})});toast('隧道已开 localhost:'+r.localPort);await loadTun();render();}catch(e){toast(e.message,'err');}}
async function startTunPort(target,port){try{const r=await api('/api/tunnel/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({target,remotePort:port})});toast('隧道已开 localhost:'+r.localPort);await loadTun();render();}catch(e){toast(e.message,'err');}}
function startTunCustom(target){const p=prompt('转发服务器上的哪个端口？(如 1521 Oracle / 9200 ES)');if(!p)return;const port=parseInt(p,10);if(!port){toast('端口无效','err');return;}startTunPort(target,port);}
async function stopTun(id){try{await api('/api/tunnel/stop',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id})});toast('隧道已关');await loadTun();render();}catch(e){toast(e.message,'err');}}

function openServerDlg(){serverDlg.showModal();}
async function submitServer(){$('s_go').disabled=true;
  try{const b={alias:$('s_alias').value.trim(),host:$('s_host').value.trim(),user:$('s_user').value.trim()||'root',port:Number($('s_port').value)||22,password:$('s_pw').value||undefined,note:$('s_note').value||undefined,auth:'key'};
    if(!b.alias||!b.host){toast('别名和 host 必填','err');return;}
    const r=await api('/api/server',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)},60000);
    if(r.success){toast('接入成功');serverDlg.close();await refreshAll();}else toast('接入失败：'+(r.error||'?'),'err');
  }catch(e){toast(e.message,'err');}finally{$('s_go').disabled=false;}}
let EDITPROJ='',EDITSRV='';
function fillSrvOpts(sel){$('p_server').innerHTML=Object.keys(CONFIG.servers||{}).map(k=>'<option'+(k===sel?' selected':'')+'>'+esc(k)+'</option>').join('');}
function openProjectDlg(){EDITPROJ='';$('pdlg_title').textContent='登记部署项目';$('p_go').textContent='登记';
  ['p_name','p_deploy','p_dir','p_containers','p_health'].forEach(id=>$(id).value='');fillSrvOpts();projectDlg.showModal();}
function openPrjEdit(k){EDITPROJ=k;const p=CONFIG.projects[k];$('pdlg_title').textContent='编辑项目';$('p_go').textContent='保存';
  $('p_name').value=k;$('p_deploy').value=p.deploy||'';$('p_dir').value=p.dir||'';$('p_containers').value=(p.containers||[]).join(',');$('p_health').value=(p.health||[]).join(',');fillSrvOpts(p.server);projectDlg.showModal();}
async function submitProject(){$('p_go').disabled=true;
  try{const sp=s=>s.split(',').map(x=>x.trim()).filter(Boolean);
    const name=$('p_name').value.trim(),server=$('p_server').value,deploy=$('p_deploy').value.trim();
    if(!name||!server||!deploy){toast('项目名/服务器/部署命令必填','err');return;}
    const body={server,deploy,dir:$('p_dir').value.trim()||undefined,containers:$('p_containers').value?sp($('p_containers').value):undefined,health:$('p_health').value?sp($('p_health').value):undefined};
    if(EDITPROJ){await api('/api/project/'+encodeURIComponent(EDITPROJ),{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.assign({newName:name},body))});toast('已保存');}
    else{await api('/api/project',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.assign({name},body))});toast('已登记');}
    if(EDITPROJ&&EDITPROJ!==name)EXP.delete('p:'+EDITPROJ);projectDlg.close();await refreshAll();
  }catch(e){toast(e.message,'err');}finally{$('p_go').disabled=false;}}
async function delProject(k){if(!confirm('从清单删除项目 '+k+'？(只移除记录，不动服务器)'))return;
  try{await api('/api/project/'+encodeURIComponent(k),{method:'DELETE'});toast('已删除');EXP.delete('p:'+k);await refreshAll();}catch(e){toast(e.message,'err');}}
function openSrvEdit(k){EDITSRV=k;const v=CONFIG.servers[k];$('se_alias').value=k;$('se_host').value=v.host||'';$('se_user').value=v.user||'';$('se_port').value=v.port||22;$('se_note').value=v.note||'';srvEditDlg.showModal();}
async function submitSrvEdit(){$('se_go').disabled=true;
  try{const newName=$('se_alias').value.trim(),host=$('se_host').value.trim(),user=$('se_user').value.trim();
    if(!newName||!host||!user){toast('别名/Host/用户必填','err');return;}
    await api('/api/server/'+encodeURIComponent(EDITSRV),{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({newName,host,user,port:Number($('se_port').value)||22,note:$('se_note').value.trim()})});
    toast('已保存');srvEditDlg.close();if(newName!==EDITSRV)EXP.delete('s:'+EDITSRV);await refreshAll();
  }catch(e){toast(e.message,'err');}finally{$('se_go').disabled=false;}}
async function delServer(k){if(!confirm('从清单删除服务器 '+k+'？(只移除记录，不动服务器本身)'))return;
  try{await api('/api/server/'+encodeURIComponent(k),{method:'DELETE'});toast('已删除');EXP.delete('s:'+k);await refreshAll();}catch(e){toast(e.message,'err');}}
let BR={server:'',cwd:'',parent:''};
function openBrowse(){const sv=$('p_server').value;if(!sv){toast('先选服务器','err');return;}BR.server=sv;brGo($('p_dir').value.trim()||'');}
// 延迟转圈：ms 内拿到结果就不显示 spinner（连接池下大多很快），只有真慢才转圈，消除翻目录闪烁
function delaySpin(id,ms){const t=setTimeout(()=>{const el=$(id);if(el)el.innerHTML='<div class="row" style="cursor:default"><span class="spin"></span></div>';},ms===undefined?220:ms);return ()=>clearTimeout(t);}
async function brGo(path){if(path==='PARENT')path=BR.parent;if(!browseDlg.open)browseDlg.showModal();const stop=delaySpin('br_list');
  try{const r=await api('/api/browse?server='+encodeURIComponent(BR.server)+(path?'&path='+encodeURIComponent(path):''));stop();
    BR.cwd=r.cwd;BR.parent=r.parent;$('br_cwd').textContent=r.cwd;
    $('br_list').innerHTML=r.dirs.length?r.dirs.map(d=>'<div class="row" onclick="brEnter(\''+esc(d).replace(/'/g,"&#39;")+'\')"><span class="nm">'+esc(d)+'</span><span class="sp"></span><span class="caret">▸</span></div>').join(''):'<div class="mt" style="padding:12px 6px">（无子目录，可直接选这个目录）</div>';
  }catch(e){stop();$('br_list').innerHTML='<div class="mt" style="padding:12px 6px">'+esc(e.message)+'</div>';}}
function brEnter(d){const sep=BR.cwd.endsWith('/')?'':'/';brGo(BR.cwd+sep+d);}
function brPick(){$('p_dir').value=BR.cwd;browseDlg.close();}
let FILE={project:'',name:''};
function openFile(k){const nm=($('fpath-'+k).value||'').trim()||'.env';openFilePath(k,nm);}
async function openFilePath(k,nm){FILE={mode:'project',project:k,name:nm};
  $('file_title').textContent=nm;$('file_sub').textContent='项目 '+k;$('file_body').value='加载中…';$('file_body').disabled=true;fileDlg.showModal();
  try{const r=await api('/api/project-file?project='+encodeURIComponent(k)+'&name='+encodeURIComponent(nm));
    $('file_body').value=r.content;$('file_sub').textContent=r.exists?('已存在 · '+r.content.length+' 字 · 保存前自动备份 .vlbak'):'文件不存在，保存将新建';
  }catch(e){$('file_body').value='';$('file_sub').textContent='读取失败：'+e.message;}finally{$('file_body').disabled=false;}}
let FB={project:'',rel:'',root:''};
function openFb(k){FB={project:k,rel:'',root:''};fbDlg.showModal();fbLoad();}
function fbSize(n){return n>=1048576?(n/1048576).toFixed(1)+'M':n>=1024?(n/1024).toFixed(1)+'K':n+'B';}
function fbGo(name){if(name==='UP')FB.rel=FB.rel.includes('/')?FB.rel.replace(/\/[^/]+$/,''):'';else FB.rel=(FB.rel?FB.rel+'/':'')+name;fbLoad();}
async function fbLoad(){const stop=delaySpin('fb_list');
  try{const r=await api('/api/project-dir?project='+encodeURIComponent(FB.project)+(FB.rel?'&rel='+encodeURIComponent(FB.rel):''));stop();
    FB.root=r.root;FB.rel=r.rel;$('fb_cwd').textContent=r.cwd;
    $('fb_list').innerHTML=r.entries.length?r.entries.map(e=>{
      if(e.type==='dir')return '<div class="row" onclick="fbGo(\''+esc(e.name).replace(/\x27/g,"&#39;")+'\')"><span class="nm">'+esc(e.name)+'/</span><span class="sp"></span><span class="caret">▸</span></div>';
      const rel=(FB.rel?FB.rel+'/':'')+e.name;
      return '<div class="row" style="cursor:default"><span class="cn" style="min-width:0">'+esc(e.name)+'</span><span class="mt">'+fbSize(e.size)+'</span><span class="sp"></span><button class="sm" onclick="openFilePath(\''+esc(FB.project)+'\',\''+esc(rel).replace(/\x27/g,"&#39;")+'\')">编辑</button></div>';
    }).join(''):'<div class="mt" style="padding:12px 6px">（空目录）</div>';
  }catch(e){stop();$('fb_list').innerHTML='<div class="mt" style="padding:12px 6px">'+esc(e.message)+'</div>';}}
function fbUpload(){$('fb_file').click();}
function fbDoUpload(){const f=$('fb_file').files[0];if(!f)return;
  if(f.size>5*1048576){toast('文件超过 5MB，请用 scp/rsync','err');$('fb_file').value='';return;}
  const rd=new FileReader();rd.onload=async()=>{const b64=String(rd.result).split(',')[1]||'';const name=(FB.rel?FB.rel+'/':'')+f.name;
    try{await api('/api/project-upload',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({project:FB.project,name,b64})},0);toast('已上传 '+f.name);fbLoad();}catch(e){toast(e.message,'err');}};
  rd.readAsDataURL(f);$('fb_file').value='';}
async function saveFile(){$('file_go').disabled=true;
  try{
    if(FILE.mode==='fs'){const b64=btoa(unescape(encodeURIComponent($('file_body').value)));
      await api('/api/fs/write',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({server:FILE.server,path:FILE.path,b64})},0);
    }else{await api('/api/project-file',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({project:FILE.project,name:FILE.name,content:$('file_body').value})});}
    toast('已保存到服务器');fileDlg.close();if(FILE.mode==='fs')fmGo(FM.cwd);
  }catch(e){toast(e.message,'err');}finally{$('file_go').disabled=false;}}

/* ---- 通用文件管理（server + 绝对路径）---- */
function je(s){return esc(String(s)).replace(/'/g,'&#39;');}
function b64ToBlob(b64){const bin=atob(b64),len=bin.length,arr=new Uint8Array(len);for(let i=0;i<len;i++)arr[i]=bin.charCodeAt(i);return new Blob([arr],{type:'application/octet-stream'});}
let FM={server:'',cwd:'',parent:''};
function openFm(server,startPath){FM={server:server,cwd:'',parent:''};fmDlg.showModal();fmGo(startPath||'');}
function fmJoin(name){return (FM.cwd==='/'?'':FM.cwd)+'/'+name;}
function fmGoInput(){const p=$('fm_path').value.trim();if(p)fmGo(p);}
function fmUp(){fmGo(FM.parent);}
function fmEnter(name){fmGo(fmJoin(name));}
async function fmGo(path){const stop=delaySpin('fm_list');
  try{const r=await api('/api/fs/list?server='+encodeURIComponent(FM.server)+(path?'&path='+encodeURIComponent(path):''));stop();
    FM.cwd=r.cwd;FM.parent=r.parent;$('fm_cwd').textContent=FM.server+' : '+r.cwd;$('fm_path').value=r.cwd;
    $('fm_list').innerHTML=r.entries.length?r.entries.map(e=>{
      const acts='<button class="sm" onclick="event.stopPropagation();fmRename(\''+je(e.name)+'\')">改名</button>'
        +'<button class="sm" onclick="event.stopPropagation();fmDelete(\''+je(e.name)+'\','+(e.type==='dir'?'true':'false')+')">删除</button>';
      if(e.type==='dir')return '<div class="row" onclick="fmEnter(\''+je(e.name)+'\')"><span class="nm">'+esc(e.name)+'/</span><span class="sp"></span>'+acts+'<span class="caret">▸</span></div>';
      return '<div class="row" style="cursor:default"><span class="cn" style="min-width:0">'+esc(e.name)+'</span><span class="mt">'+fbSize(e.size)+'</span><span class="sp"></span>'
        +'<button class="sm" onclick="event.stopPropagation();fmEdit(\''+je(e.name)+'\')">编辑</button>'
        +'<button class="sm" onclick="event.stopPropagation();fmDownload(\''+je(e.name)+'\')">下载</button>'+acts+'</div>';
    }).join(''):'<div class="mt" style="padding:12px 6px">（空目录）</div>';
  }catch(e){stop();$('fm_list').innerHTML='<div class="mt" style="padding:12px 6px">'+esc(e.message)+'</div>';}}
async function fmMkdir(){const n=(prompt('新建文件夹名称：')||'').trim();if(!n)return;if(n.includes('/')){toast('名称不能含 /','err');return;}
  try{await api('/api/fs/mkdir',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({server:FM.server,path:fmJoin(n)})});toast('已新建');fmGo(FM.cwd);}catch(e){toast(e.message,'err');}}
function fmUpload(){$('fm_file').click();}
function fmDoUpload(){const f=$('fm_file').files[0];if(!f)return;
  if(f.size>25*1048576){toast('文件超过 25MB，请用 scp/rsync','err');$('fm_file').value='';return;}
  const rd=new FileReader();rd.onload=async()=>{const b64=String(rd.result).split(',')[1]||'';
    try{await api('/api/fs/write',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({server:FM.server,path:fmJoin(f.name),b64})},0);toast('已上传 '+f.name);fmGo(FM.cwd);}catch(e){toast(e.message,'err');}};
  rd.readAsDataURL(f);$('fm_file').value='';}
async function fmEdit(name){const p=fmJoin(name);FILE={mode:'fs',server:FM.server,path:p};
  $('file_title').textContent=name;$('file_sub').textContent=FM.server+' : '+p;$('file_body').value='加载中…';$('file_body').disabled=true;fileDlg.showModal();
  try{const r=await api('/api/fs/read?server='+encodeURIComponent(FM.server)+'&path='+encodeURIComponent(p));
    $('file_body').value=r.content;$('file_sub').textContent=(r.exists?'已存在 · '+r.content.length+' 字 · 保存前自动备份 .vlbak':'新文件')+' · '+p;
  }catch(e){$('file_body').value='';$('file_sub').textContent='读取失败：'+e.message;}finally{$('file_body').disabled=false;}}
async function fmDownload(name){try{toast('下载准备中…');const r=await api('/api/fs/download?server='+encodeURIComponent(FM.server)+'&path='+encodeURIComponent(fmJoin(name)),undefined,60000);
    const url=URL.createObjectURL(b64ToBlob(r.b64));const a=document.createElement('a');a.href=url;a.download=r.name||name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}catch(e){toast(e.message,'err');}}
async function fmRename(name){const nn=(prompt('重命名为（同目录填名称，或填绝对路径移动）：',name)||'').trim();if(!nn||nn===name)return;
  const dest=nn.startsWith('/')?nn:fmJoin(nn);
  try{await api('/api/fs/rename',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({server:FM.server,path:fmJoin(name),dest})});toast('已重命名');fmGo(FM.cwd);}catch(e){toast(e.message,'err');}}
async function fmDelete(name,isDir){if(!confirm('删除'+(isDir?'文件夹':'文件')+' '+name+' ？\n'+(isDir?'整个目录会被 rm -rf 递归删除，':'')+'此操作不可恢复。'))return;
  try{await api('/api/fs/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({server:FM.server,path:fmJoin(name)})});toast('已删除');fmGo(FM.cwd);}catch(e){toast(e.message,'err');}}

/* ---- 容器管理（服务器维度：列全部 + 删停止 + 一键 prune）---- */
function ctsHtml(server){const a=CTS[server];if(!a)return '<span class="mt"><span class="spin"></span> 加载容器…</span>';
  if(a.error)return '<span class="mt">'+esc(a.error)+'</span>';
  const list=a.list,stopped=list.filter(c=>!c.running).length;
  return '<div class="mt" style="margin-bottom:6px">共 '+list.length+' 个 · 运行 '+(list.length-stopped)+' · 停止 '+stopped+'</div>'+
    (list.length?list.map(c=>'<div class="citem"><span class="dot '+(c.running?'ok':'bad')+'"></span><span class="cn">'+esc(c.name)+'</span>'
      +'<span class="mt" style="color:var(--faint)">'+esc(c.state)+'</span><span class="sp"></span>'
      +(c.running
        ?'<button class="sm" onclick="event.stopPropagation();showLogs(\''+je(server)+'\',\''+je(c.name)+'\')">日志</button><button class="sm" onclick="event.stopPropagation();restartC(\''+je(server)+'\',\''+je(c.name)+'\')">重启</button><button class="sm" onclick="event.stopPropagation();stopC(\''+je(server)+'\',\''+je(c.name)+'\')">停止</button>'
        :'<button class="sm" onclick="event.stopPropagation();startC(\''+je(server)+'\',\''+je(c.name)+'\')">启动</button><button class="sm" onclick="event.stopPropagation();delCt(\''+je(server)+'\',\''+je(c.name)+'\')">删除</button>')
      +'<button class="sm" onclick="event.stopPropagation();inspectC(\''+je(server)+'\',\''+je(c.name)+'\')">详情</button>'
      +'</div>').join(''):'<span class="mt">无容器</span>');}
async function loadCts(server){try{const a=await api('/api/containers?server='+encodeURIComponent(server),undefined,30000);CTS[server]={list:a};}catch(e){CTS[server]={list:[],error:e.message};}render();}
async function delCt(server,name){if(!confirm('删除容器 '+name+' ？\n仅删除已停止的容器，不可恢复（镜像和数据卷不受影响）。'))return;
  try{await api('/api/container-remove',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({server,container:name})});toast(name+' 已删除');loadCts(server);loadStats();}catch(e){toast(e.message,'err');}}
async function pruneCts(server){if(!confirm('清理 '+server+' 上所有【已停止】的容器？\n会执行 docker container prune，删除全部停止状态的容器，不可恢复。\n（运行中的容器不受影响）'))return;
  try{const r=await api('/api/container-prune',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({server})},60000);toast('已清理 '+r.removed+' 个，释放 '+r.reclaimed);loadCts(server);loadStats();}catch(e){toast(e.message,'err');}}
function openGit(k){$('g_proj').value=k;$('g_repo').value='';gitDlg.showModal();}
async function submitGit(){$('g_go').disabled=true;
  try{const b={repo:$('g_repo').value.trim(),branch:$('g_branch').value.trim()||'main',adopt:$('g_adopt').checked};if(!b.repo){toast('仓库必填','err');return;}
    toast('执行中…');const r=await api('/api/setup-git/'+encodeURIComponent($('g_proj').value),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)},0);
    if(r.success){toast('已转 git @ '+(r.gitRev||'?'));gitDlg.close();doStatus($('g_proj').value);}else toast('失败：'+(r.error||'?'),'err');
  }catch(e){toast(e.message,'err');}finally{$('g_go').disabled=false;}}

try{THEME=localStorage.getItem('vl-theme')||'system';}catch(e){}
try{HIDEIP=localStorage.getItem('vl-hideip')==='1'}catch(e){}
try{AUTOREF=localStorage.getItem('vl-autoref')==='1';}catch(e){AUTOREF=false;}
try{var _as=+localStorage.getItem('vl-autoref-sec');if(_as)AUTOREF_SEC=_as;}catch(e){}
applyTheme();
matchMedia('(prefers-color-scheme: dark)').addEventListener('change',()=>{if(THEME==='system')applyTheme();});
logDlg.addEventListener('close',()=>{if(LOG.es){LOG.es.close();LOG.es=null;}});
(async()=>{await loadConfig();loadMcp().then(()=>{if(VIEW==='mcp')render();});go('overview');loadStats();await Promise.all([loadStatus(),loadTun()]);render();applyAutoref();})();
</script>
</body></html>`;
