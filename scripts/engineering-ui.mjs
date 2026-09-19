#!/usr/bin/env node
/**
 * CareerScope Engineering Control Center — local web UI.
 *
 * Deliberately standalone rather than a route inside the product: the
 * application must not change to display its own control plane, and this has to
 * work with no production access. It serves one page that reads the canonical
 * `.ai/*.json` state.
 *
 * Read-only. There are no write controls, so nothing here can alter engineering
 * state or the application.
 *
 *   npm run agile:ui        then open the printed URL
 */
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const AI = '.ai';
const PORT = Number(process.env.PORT ?? 7777);

const read = (p, fallback = null) => {
  if (!existsSync(p)) return fallback;
  try {
    return JSON.parse(readFileSync(p, 'utf8').replace(/\r\n/g, '\n'));
  } catch {
    return fallback;
  }
};
const git = (args, fallback = null) => {
  try {
    return execFileSync('git', args, { encoding: 'utf8' }).trim();
  } catch {
    return fallback;
  }
};
function isoWeek(date = new Date()) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return `${d.getUTCFullYear()}-W${String(Math.ceil(((d - yearStart) / 86400000 + 1) / 7)).padStart(2, '0')}`;
}

const STALE_MS = 15 * 60 * 1000;

function agentsFromDisk() {
  const dir = '.github/agents';
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.agent.md'))
    .map((file) => {
      const body = readFileSync(join(dir, file), 'utf8');
      const front = body.slice(0, body.indexOf('\n---', 4));
      const tools = [...front.matchAll(/'([^']+)'/g)].map((m) => m[1]);
      return {
        id: file.replace('.agent.md', ''),
        name: /^name:\s*(.+)$/m.exec(front)?.[1]?.trim() ?? file,
        permission: tools.includes('edit')
          ? 'WRITE'
          : tools.some((t) => t === 'execute' || t.startsWith('execute/'))
            ? 'EXECUTE'
            : 'READ ONLY',
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function snapshot() {
  const week = isoWeek();
  const loop = read(join(AI, 'LOOP-STATE.json'), {});
  const beat = loop.lastHeartbeat ? Date.now() - Date.parse(loop.lastHeartbeat) : null;
  const running = ['RUNNING', 'REVIEWING', 'IMPLEMENTING', 'TESTING'].includes(
    String(loop.status).toUpperCase(),
  );
  const scrumDir = join(AI, 'scrum');
  const scrums = existsSync(scrumDir) ? readdirSync(scrumDir).sort().reverse() : [];
  return {
    generatedAt: new Date().toISOString(),
    repo: {
      branch: git(['branch', '--show-current'], 'unknown'),
      commit: git(['rev-parse', '--short', 'HEAD'], '?'),
      // v2 is what serves careerscope.tech. The root package.json is the V1
      // line and reads 1.3.4, so showing it here labelled "Version" claimed the
      // deployed application was three major versions older than it is.
      version: read('v2/package.json', {}).version ?? '?',
      legacyVersion: read('package.json', {}).version ?? '?',
    },
    week,
    mode: read(join(AI, 'process-mode.json'), { mode: 'ACTIVE' }),
    sprint: read(join(AI, 'sprints', `${week}.json`)),
    retro: read(join(AI, 'sprints', `${week}-retrospective.json`)),
    scrum: scrums[0] ? read(join(scrumDir, scrums[0])) : null,
    backlog: read(join(AI, 'backlog.json'), { items: [] }),
    findings: read(join(AI, 'findings.json'), { findings: [] }),
    releasePlan: read(join(AI, 'release-plan.json'), {}),
    progress: read(join(AI, 'progress.json'), { areas: [] }),
    discovery: read(join(AI, 'product-discovery.json'), { candidates: [] }),
    skills: read(join(AI, 'skill-registry.json'), {}),
    runs: (read(join(AI, 'runs.json'), { runs: [] }).runs ?? []).slice(-12).reverse(),
    loop,
    // Staleness is load-bearing: it stops the UI implying an abandoned run is live.
    live: running && beat !== null && beat <= STALE_MS,
    stale: running && beat !== null && beat > STALE_MS,
    heartbeatAgeMs: beat,
    agents: agentsFromDisk(),
    history: dailyProgress(),
    activity: dailyActivity(),
  };
}

/**
 * Daily progress, derived from git history of .ai/progress.json.
 *
 * Real history, not a synthesised trend: each point is a commit that actually
 * changed the matrix. A day with no commit produces no point rather than a
 * flat line implying someone looked and confirmed no change.
 */
function dailyProgress() {
  try {
    const log = execFileSync('git', ['log', '--format=%H|%cI', '--', '.ai/progress.json'], {
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean)
      .slice(0, 30)
      .reverse();
    const points = [];
    for (const line of log) {
      const [sha, when] = line.split('|');
      try {
        const doc = JSON.parse(
          execFileSync('git', ['show', `${sha}:.ai/progress.json`], { encoding: 'utf8' }),
        );
        const areas = doc.areas ?? [];
        if (!areas.length) continue;
        points.push({
          date: when.slice(0, 10),
          commit: sha.slice(0, 7),
          overall:
            doc.overall ?? Math.round(areas.reduce((s, a) => s + a.percent, 0) / areas.length),
          areas: Object.fromEntries(areas.map((a) => [a.area, a.percent])),
        });
      } catch {
        continue;
      }
    }
    // Last point per day, so several commits in a day do not read as several days.
    const byDay = new Map();
    for (const p of points) byDay.set(p.date, p);
    return [...byDay.values()];
  } catch {
    return [];
  }
}

/** Commits per day, so "what changed today" is answerable without guessing. */
function dailyActivity() {
  try {
    return execFileSync('git', ['log', '--since=14.days', '--format=%h|%cI|%s'], {
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [sha, when, ...rest] = l.split('|');
        return { sha, at: when, date: when.slice(0, 10), subject: rest.join('|') };
      });
  } catch {
    return [];
  }
}

const PAGE = `<!doctype html>
<html lang="en" data-theme="dark"><head><meta charset="utf-8"><title>CareerScope Engineering</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{--bg:#080B10;--surface:#0F141A;--panel:#141B22;--line:#1F2937;--ink:#F4F7FA;--muted:#AEB8C4;--ok:#2DD4A5;--info:#38BDF8;--warn:#F59E0B;--bad:#EF4444;--dim:#64748B;--unmeasured:#94A3B8;--focus:#7DE7CF;--hover:#151E26;--purple:#A78BFA;color-scheme:dark}
html[data-theme=light]{--bg:#F5F7FA;--surface:#FFFFFF;--panel:#FFFFFF;--line:#D8E0E8;--ink:#10151B;--muted:#52606D;--ok:#0B7F68;--info:#1E64D6;--warn:#B45309;--bad:#DC2626;--dim:#64748B;--unmeasured:#6B7A8A;--focus:#0B7F68;--hover:#EEF2F5;--purple:#6D4AE0;color-scheme:light}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:400 13px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;display:grid;grid-template-columns:200px minmax(0,1fr);min-height:100vh}
:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.grow{flex:1}
/* Sidebar */
aside{background:var(--surface);border-right:1px solid var(--line);display:flex;flex-direction:column;padding:18px 12px;gap:6px;position:sticky;top:0;height:100vh}
.brand{display:flex;align-items:center;gap:10px;padding:0 8px 16px}
.brand b{font-size:17px;font-weight:700;letter-spacing:-.02em;display:block;line-height:1.15}
.brand span{color:var(--muted);font-size:12px}
nav{display:flex;flex-direction:column;gap:2px}
nav button{display:flex;align-items:center;gap:10px;background:none;border:0;border-radius:6px;color:var(--muted);padding:9px 10px;cursor:pointer;font:inherit;font-size:13px;font-weight:500;text-align:left}
nav button:hover{background:var(--hover);color:var(--ink)}
nav button[aria-current=page]{background:var(--panel);color:var(--ink);box-shadow:inset 2px 0 0 var(--ok)}
.side-foot{margin-top:auto;display:flex;flex-direction:column;gap:14px;padding:0 8px}
.proc{display:flex;gap:9px;align-items:flex-start}
.proc .k{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.04em;display:block;margin-bottom:2px}
.proc b{color:var(--warn);font-size:13px;display:block}
.proc small{color:var(--muted);font-size:11px}
.themebtn{display:flex;align-items:center;gap:9px;background:none;border:0;color:var(--muted);cursor:pointer;font:inherit;font-size:12px;padding:0}
.themebtn:hover{color:var(--ink)}
/* Top bar */
.top{display:flex;align-items:center;gap:12px;padding:16px 22px;border-bottom:1px solid var(--line)}
.top h1{font-size:16px;font-weight:600;letter-spacing:-.01em;margin:0}
.loc{display:flex;align-items:center;gap:7px;color:var(--muted);font-size:12px}
.upd{text-align:right;color:var(--muted);font-size:11px;line-height:1.35}
.upd b{display:block;color:var(--ink);font-size:12px;font-weight:500}
.icon-btn{width:34px;height:34px;display:inline-flex;align-items:center;justify-content:center;border:1px solid var(--line);border-radius:8px;background:var(--panel);color:var(--muted);cursor:pointer}
.icon-btn:hover{color:var(--ink);background:var(--hover)}
main{padding:20px 22px 28px;display:grid;gap:16px;align-content:start}
/* Cards */
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:18px}
.card h2{font-size:17px;font-weight:600;letter-spacing:-.01em;margin:0 0 14px}
.row3{display:grid;gap:16px;grid-template-columns:repeat(3,minmax(0,1fr))}
@media (max-width:1180px){.row3{grid-template-columns:minmax(0,1fr)}}
.donutwrap{display:flex;align-items:center;gap:22px}
.donut{position:relative;flex:0 0 auto}
.donut .mid{position:absolute;inset:0;display:grid;place-content:center;text-align:center}
.donut .mid b{font-size:30px;font-weight:700;letter-spacing:-.02em;display:block;line-height:1}
.donut .mid span{color:var(--muted);font-size:11px}
.legend{display:grid;gap:9px;flex:1;min-width:0}
.legend div{display:flex;align-items:center;gap:9px;font-size:13px}
.legend .n{margin-left:auto;color:var(--muted);font-variant-numeric:tabular-nums}
.sw{width:9px;height:9px;border-radius:50%;flex:0 0 auto}
.based{color:var(--muted);font-size:11px;margin-top:14px}
.barrow{display:grid;grid-template-columns:96px minmax(0,1fr) 42px;align-items:center;gap:12px;margin-bottom:11px;font-size:13px}
.track{height:9px;background:var(--surface);border:1px solid var(--line);border-radius:5px;overflow:hidden}
.track>i{display:block;height:100%;border-radius:4px}
.track.none{background:repeating-linear-gradient(45deg,transparent,transparent 3px,var(--line) 3px,var(--line) 6px)}
.pc{text-align:right;color:var(--muted);font-variant-numeric:tabular-nums;font-size:12px}
.more{display:inline-flex;gap:6px;align-items:center;background:none;border:0;color:var(--muted);font:inherit;font-size:12px;cursor:pointer;padding:0;margin-top:6px}
.more:hover{color:var(--ok)}
.info{display:flex;gap:10px;background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:11px 12px;margin-top:16px;font-size:12px}
.info b{display:block;font-weight:600}
.info span{color:var(--muted)}
/* Board */
.boardhead{display:flex;align-items:flex-start;gap:12px;margin-bottom:14px}
.boardhead h2{margin:0}
.boardhead p{margin:2px 0 0;color:var(--muted);font-size:12px}
.board{display:grid;gap:12px;grid-template-columns:repeat(6,minmax(0,1fr))}
@media (max-width:1280px){.board{grid-template-columns:repeat(3,minmax(0,1fr))}}
@media (max-width:700px){.board{grid-template-columns:minmax(0,1fr)}}
.col{border:1px solid var(--line);border-radius:8px;background:var(--surface);display:flex;flex-direction:column;min-width:0}
.colhead{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:11px 12px;border-bottom:1px solid var(--line);font-size:13px;font-weight:600;border-top:2px solid var(--c,var(--line));border-radius:8px 8px 0 0}
.count{background:var(--panel);border:1px solid var(--line);border-radius:999px;min-width:22px;text-align:center;padding:0 6px;font-size:12px;color:var(--muted);font-variant-numeric:tabular-nums}
.colbody{padding:10px;display:flex;flex-direction:column;gap:9px;min-height:150px}
.bcard{background:var(--panel);border:1px solid var(--line);border-radius:7px;padding:10px}
.bcard.blocked{border-left:3px solid var(--bad)}
.bid{color:var(--muted);font-size:11px;letter-spacing:.02em}
.btitle{font-size:12.5px;font-weight:600;line-height:1.35;margin:3px 0 8px}
.tags{display:flex;gap:6px;flex-wrap:wrap}
.tag{font-size:10.5px;font-weight:600;border-radius:4px;padding:2px 7px;background:var(--surface);border:1px solid var(--line);color:var(--muted)}
.tag.P0,.tag.P1{color:var(--bad);border-color:color-mix(in srgb,var(--bad) 45%,transparent)}
.tag.P2{color:var(--warn);border-color:color-mix(in srgb,var(--warn) 45%,transparent)}
.tag.P3{color:var(--dim)}
.tag.product{color:var(--purple);border-color:color-mix(in srgb,var(--purple) 45%,transparent)}
.tag.engineering{color:var(--ok);border-color:color-mix(in srgb,var(--ok) 45%,transparent)}
.mt{display:grid;place-items:center;gap:8px;text-align:center;color:var(--muted);padding:26px 8px;margin:auto 0}
.mt b{color:var(--ink);font-size:12.5px;font-weight:600}
.mt small{font-size:11.5px;line-height:1.5;max-width:170px;display:block}
/* Stat strip */
.strip{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));background:var(--panel);border:1px solid var(--line);border-radius:10px;overflow:hidden}
@media (max-width:1180px){.strip{grid-template-columns:repeat(3,minmax(0,1fr))}}
@media (max-width:620px){.strip{grid-template-columns:repeat(2,minmax(0,1fr))}}
.stat{display:flex;align-items:center;gap:12px;padding:16px 18px;border-right:1px solid var(--line)}
.stat:last-child{border-right:0}
.stat .sv{font-size:20px;font-weight:700;letter-spacing:-.01em;line-height:1.1;font-variant-numeric:tabular-nums}
.stat .sk{color:var(--muted);font-size:11.5px}
table{width:100%;border-collapse:collapse}
td,th{text-align:left;padding:9px 10px;border-bottom:1px solid var(--line)}
th{color:var(--muted);font-weight:500;font-size:11.5px;text-transform:uppercase;letter-spacing:.03em}
tbody tr:hover{background:var(--hover)}
.ok{color:var(--ok)}.warn{color:var(--warn)}.bad{color:var(--bad)}.muted{color:var(--muted)}
.dot{width:8px;height:8px;border-radius:50%;background:var(--dim);display:inline-block}
.dot.ok{background:var(--ok)}.dot.warn{background:var(--warn)}.dot.bad{background:var(--bad)}
.empty{color:var(--muted);padding:12px 0}
.vh{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
.skip{position:absolute;left:-9999px}
.skip:focus{left:12px;top:10px;z-index:30;background:var(--ok);color:var(--bg);padding:8px 12px;border-radius:6px}
main:focus{outline:none}
/* When the source is gone the header stops looking healthy. */
.top.down .loc .dot{background:var(--bad)}
.top.down{border-bottom-color:var(--bad)}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
@media (max-width:860px){body{grid-template-columns:minmax(0,1fr)}aside{position:static;height:auto;flex-direction:row;align-items:center;flex-wrap:wrap}nav{flex-direction:row}.side-foot{margin:0 0 0 auto;flex-direction:row;align-items:center;gap:18px}}
</style></head><body>
<a class="skip" href="#main">Skip to content</a>
<aside>
  <div class="brand">
    <svg width="26" height="26" viewBox="0 0 56 56" aria-hidden="true" fill="none" style="color:var(--ok)"><path fill="currentColor" fill-rule="evenodd" d="M52 26C52 39.255 41.255 50 28 50C14.745 50 4 39.255 4 26C4 12.745 14.745 2 28 2C38.1 2 46.9 8.15 50.25 17H40.2C37.8 13.75 33.35 11 28 11C19.715 11 13 17.715 13 26C13 34.285 19.715 41 28 41C33.35 41 37.8 38.25 40.2 35H50.25C46.9 43.85 38.1 50 28 50Z"/><circle cx="39" cy="26" r="4.25" fill="currentColor"/></svg>
    <span><b>CareerScope</b>Engineering</span>
  </div>
  <nav id="nav"></nav>
  <div class="side-foot">
    <div class="proc" id="proc"></div>
    <div><div class="proc"><div><span class="k">Last updated</span><small class="mono" id="stamp">—</small></div></div></div>
    <button class="themebtn" id="theme" type="button"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="4" stroke="currentColor" stroke-width="1.75"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6 6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/></svg><span id="themelabel">Dark mode</span></button>
  </div>
</aside>
<div>
  <div class="top">
    <h1>Engineering Control Centre</h1>
    <span class="loc"><span class="dot ok"></span>Local · 127.0.0.1:7777</span>
    <span class="grow"></span>
    <span class="upd"><span>Last updated</span><b id="hdr">—</b></span>
    <button class="icon-btn" id="refresh" type="button" aria-label="Refresh now"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
  </div>
  <main id="main" tabindex="-1"></main>
  <p id="live" class="vh" role="status" aria-live="polite"></p>
</div>
<script>
const TABS=[['Overview','M4 5h7v7H4zM13 5h7v4h-7zM13 11h7v8h-7zM4 14h7v5H4z'],['Agents','M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM4 20a8 8 0 0 1 16 0'],['Backlog','M5 4h14v16H5zM8 9h8M8 13h8M8 17h5']];
let tab='Overview',d={};
const esc=s=>String(s??'—').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const num=n=>Number(n).toLocaleString('en-US');

// Ring drawn from real counts. A segment is only rendered when it has a value,
// so an absent category never shows as a sliver that looks like data.
function ring(size,stroke,segs,mid){
  const r=(size-stroke)/2,c=2*Math.PI*r,total=segs.reduce((a,s)=>a+s.n,0);
  let off=0;
  const arcs=total===0
    ?'<circle cx="'+size/2+'" cy="'+size/2+'" r="'+r+'" stroke="var(--line)" stroke-width="'+stroke+'" fill="none"/>'
    :segs.filter(s=>s.n>0).map(s=>{
        const len=(s.n/total)*c,dash=len+' '+(c-len),el='<circle cx="'+size/2+'" cy="'+size/2+'" r="'+r+'" stroke="'+s.c+'" stroke-width="'+stroke+'" fill="none" stroke-dasharray="'+dash+'" stroke-dashoffset="'+(-off)+'" stroke-linecap="butt"/>';
        off+=len;return el;}).join('');
  return '<div class="donut" style="width:'+size+'px;height:'+size+'px"><svg width="'+size+'" height="'+size+'" viewBox="0 0 '+size+' '+size+'" style="transform:rotate(-90deg)" aria-hidden="true">'+arcs+'</svg><div class="mid">'+mid+'</div></div>';
}
const legendRows=segs=>'<div class="legend">'+segs.map(s=>'<div><span class="sw" style="background:'+s.c+'"></span>'+esc(s.k)+'<span class="n">'+num(s.n)+'</span></div>').join('')+'</div>';

function overallCard(){
  const areas=d.progress.areas||[];
  const by=s=>areas.filter(a=>a.status===s).length;
  const segs=[
    {k:'Completed',n:by('VERIFIED'),c:'var(--ok)'},
    {k:'In Progress',n:by('IN PROGRESS'),c:'var(--info)'},
    {k:'Not Started',n:by('NOT STARTED'),c:'var(--dim)'},
    {k:'Blocked',n:by('BLOCKED'),c:'var(--bad)'},
    {k:'Unmeasured',n:by('UNMEASURED'),c:'var(--unmeasured)'},
  ];
  const measured=areas.filter(a=>typeof a.percent==='number');
  const pct=measured.length?Math.round(measured.reduce((t,a)=>t+a.percent,0)/measured.length):null;
  const mid=pct===null?'<b>—</b><span>unmeasured</span>':'<b>'+pct+'%</b>';
  return '<div class="card"><h2>CareerScope Overall Progress</h2><div class="donutwrap">'
    +ring(150,16,segs,mid)+legendRows(segs)+'</div>'
    +'<div class="based">Mean of '+measured.length+' measured area'+(measured.length===1?'':'s')+' of '+areas.length+' tracked. '+(areas.length-measured.length)+' are unmeasured and excluded, not counted as zero.</div></div>';
}
function appCard(){
  const areas=d.progress.areas||[];
  const colour=a=>a.percent>=85?'var(--ok)':a.percent>=50?'var(--info)':'var(--purple)';
  return '<div class="card"><h2>Application Progress</h2>'
    +areas.map(a=>{
      const none=typeof a.percent!=='number';
      return '<div class="barrow"><span>'+esc(a.area)+'</span>'
        +(none?'<div class="track none"></div>':'<div class="track"><i style="width:'+a.percent+'%;background:'+colour(a)+'"></i></div>')
        +'<span class="pc">'+(none?'—':a.percent+'%')+'</span></div>';}).join('')
    +'<button class="more" data-goto="Overview">Unmeasured areas show a hatched bar, never 0%</button></div>';
}
function agentsCard(){
  const st=d.loop.agents||{};
  const vals=d.agents.map(a=>String(st[a.id]||'WAITING').toUpperCase());
  const count=f=>vals.filter(f).length;
  const segs=[
    {k:'Active',n:count(v=>v==='RUNNING'||v==='IMPLEMENTING'||v==='REVIEWING'),c:'var(--ok)'},
    {k:'Idle / Ready',n:count(v=>v==='WAITING'||v==='READY'),c:'var(--info)'},
    {k:'Busy',n:count(v=>v==='TESTING'||v==='BUSY'),c:'var(--warn)'},
    {k:'Blocked',n:count(v=>v==='BLOCKED'),c:'var(--bad)'},
    {k:'Error',n:count(v=>v==='FAILED'||v==='ERROR'),c:'var(--dim)'},
  ];
  const acted=Array.isArray(d.loop.activity)?d.loop.activity.length:0;
  return '<div class="card"><h2>Agents</h2><div class="donutwrap">'
    +ring(140,14,segs,'<b>'+d.agents.length+'</b><span>agents</span>')+legendRows(segs)+'</div>'
    +'<div class="info"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true" style="flex:0 0 auto;color:var(--info)"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.75"/><path d="M12 11v5M12 8h.01" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/></svg>'
    +'<span><b>State is operator-reported</b>'+(acted===0?'Agents have not executed. No runs observed.':acted+' handoff(s) recorded. State is reported, not probed.')+'</span></div>'
    +'<button class="more" data-goto="Agents">View agents →</button></div>';
}

// Six columns over the internal statuses. Anything unmapped gets its own column
// rather than vanishing; a board that drops work is worse than no board.
const COLS=[
  ['Backlog',['IDEA','DISCOVERY'],'var(--dim)','No ideas captured','New ideas will appear here.'],
  ['To Do',['READY','PLANNED'],'var(--info)','Nothing queued','Ready work will appear here.'],
  ['In Progress',['IN_PROGRESS','CODE_REVIEW','SECURITY'],'var(--warn)','Nothing in flight','Work being built will appear here.'],
  ['QA',['QA'],'var(--purple)','No items in QA','Items will appear here when ready for testing.'],
  ['Ready',['READY_FOR_RELEASE'],'var(--ok)','No items ready','Completed work awaiting release.'],
  ['Production',['RELEASED'],'var(--ok)','Nothing released yet','Shipped work will appear here.'],
];
function boardCard(limit){
  const items=d.backlog.items||[];
  const mapped=new Set(COLS.flatMap(c=>c[1]));
  const loose=items.filter(i=>!mapped.has(i.status));
  const cols=loose.length?[...COLS,['Not mapped',[],'var(--bad)','—','These statuses match no column.']]:COLS;
  const tile=i=>'<div class="bcard'+(i.status==='BLOCKED'?' blocked':'')+'"><div class="bid">'+esc(i.id)+'</div><div class="btitle">'+esc(i.title)+'</div><div class="tags"><span class="tag '+esc(i.priority)+'">'+esc(i.priority)+'</span><span class="tag '+esc(i.dimension||'')+'">'+esc(i.dimension||'?')+'</span>'+(i.carriedCount?'<span class="tag P2">carried '+i.carriedCount+'×</span>':'')+'</div></div>';
  return '<div class="card"><div class="boardhead"><div><h2>Work Backlog</h2><p>From idea to production</p></div><span class="grow"></span><span class="muted" style="font-size:12px">'+num(items.length)+' items</span>'
    +(limit?'<button class="more" data-goto="Backlog">View all →</button>':'')+'</div>'
    +'<div class="board">'+cols.map(([name,st,c,t,sub])=>{
      const list=name==='Not mapped'?loose:items.filter(i=>st.includes(i.status));
      const show=limit?list.slice(0,3):list;
      return '<section class="col"><div class="colhead" style="--c:'+c+'">'+esc(name)+'<span class="count">'+list.length+'</span></div><div class="colbody">'
        +(list.length?show.map(tile).join('')+(list.length>show.length?'<button class="more" data-goto="Backlog">+ '+(list.length-show.length)+' more</button>':'')
          :'<div class="mt"><b>'+esc(t)+'</b><small>'+esc(sub)+'</small></div>')
        +'</div></section>';}).join('')+'</div></div>';
}
function strip(){
  const f=d.findings.items||d.findings.findings||[];
  const open=f.filter(x=>x.status!=='FIXED'&&x.status!=='CLOSED');
  const n=s=>open.filter(x=>x.severity===s).length;
  const items=d.backlog.items||[];
  const active=items.filter(i=>['IN_PROGRESS','CODE_REVIEW','QA','SECURITY'].includes(i.status)).length;
  const cell=(v,k,cls)=>'<div class="stat"><div><div class="sv '+(cls||'')+'">'+esc(v)+'</div><div class="sk">'+esc(k)+'</div></div></div>';
  return '<div class="strip">'+cell(num(items.length),'Total items')
    +cell(n('P0'),'P0 findings',n('P0')?'bad':'')
    +cell(n('P1'),'P1 findings',n('P1')?'warn':'')
    +cell(n('P2'),'P2 findings')
    +cell(active+'/2','WIP',active>2?'bad':'ok')
    +cell(d.sprint&&d.sprint.targetReleaseDate?d.sprint.targetReleaseDate:'—','Target release')+'</div>';
}
function Overview(){return '<div class="row3">'+overallCard()+appCard()+agentsCard()+'</div>'+boardCard(true)+strip();}
function Backlog(){return boardCard(false)+strip();}
function Agents(){
  const st=d.loop.agents||{};
  return agentsCard()+'<div class="card"><h2>All agents</h2><table><tr><th></th><th>Agent</th><th>State</th><th>Permission</th></tr>'
   +d.agents.map(a=>{const s=(st[a.id]||'WAITING').toUpperCase();
     return '<tr><td><span class="dot'+(d.live&&d.loop.activeAgent===a.id?' ok':'')+'"></span></td><td>'+esc(a.name)+'</td><td class="'+(s==='BLOCKED'||s==='FAILED'?'bad':'muted')+'">'+esc(s)+'</td><td class="muted">'+esc(a.permission)+'</td></tr>';}).join('')
   +'</table></div>';
}
const VIEWS={Overview,Agents,Backlog};
function stamp(){
  const age=Math.round((Date.now()-Date.parse(d.generatedAt))/1000);
  return age>60?age+'s ago — stale':(age<5?'just now':age+'s ago');
}
// The nav is built once. Rebuilding it on every repaint destroyed the focused
// element, so a keyboard user lost their place whenever the data changed.
function buildNav(){
  document.getElementById('nav').innerHTML=TABS.map(([t,p])=>
    '<button type="button" data-view="'+t+'"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="'+p+'" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>'+t+'</button>').join('');
}
function markNav(){
  for(const b of document.querySelectorAll('#nav button')){
    if(b.dataset.view===tab)b.setAttribute('aria-current','page');
    else b.removeAttribute('aria-current');
  }
}
function paint(){
  markNav();
  const paused=d.mode&&d.mode.mode==='PAUSED';
  document.getElementById('proc').innerHTML='<span class="dot '+(paused?'warn':'ok')+'" style="margin-top:5px"></span><div><span class="k">Process</span><b style="color:var(--'+(paused?'warn':'ok')+')">'+(paused?'PAUSED':'ACTIVE')+'</b>'+(paused?'<small>until '+esc(d.mode.resumeOn||'—')+'</small>':'')+'</div>';
  document.getElementById('stamp').textContent=new Date(d.generatedAt).toLocaleString();
  document.getElementById('hdr').textContent=stamp();
  document.getElementById('main').innerHTML=VIEWS[tab]();
  document.title=tab+' — CareerScope Engineering';
}
function go(t){
  if(!VIEWS[t])return;
  tab=t;paint();
  document.getElementById('main').focus();
  say(t+' view');
}
const say=m=>{const l=document.getElementById('live');if(l)l.textContent=m;};
// One delegated listener rather than inline handlers, so re-rendered content
// never carries a stale reference and nothing depends on a global.
document.body.addEventListener('click',e=>{
  const nav=e.target.closest('#nav button[data-view]');
  if(nav){go(nav.dataset.view);return;}
  const jump=e.target.closest('[data-goto]');
  if(jump)go(jump.dataset.goto);
});
document.getElementById('theme').addEventListener('click',()=>{
  const light=document.documentElement.getAttribute('data-theme')==='light';
  const next=light?'dark':'light';
  document.documentElement.setAttribute('data-theme',next);
  document.getElementById('themelabel').textContent=light?'Dark mode':'Light mode';
  say(next==='light'?'Light theme':'Dark theme');
});
document.getElementById('refresh').addEventListener('click',()=>{say('Refreshing');load();});
let lastSig='',failures=0;
function offline(message){
  document.getElementById('hdr').textContent='unavailable';
  document.querySelector('.top').classList.add('down');
  // Say so on the page. A dashboard that keeps showing the last good reading
  // while the source is gone is indistinguishable from one that is working.
  document.getElementById('main').innerHTML=
    '<div class="card" role="alert"><h2>State unavailable</h2><p class="muted" style="margin:0 0 6px">'+esc(message)+'</p>'
    +'<p class="muted" style="margin:0">The figures below the header are from the last successful read and are no longer being updated. Check that <span class="mono">npm run ui:engineering</span> is still running.</p></div>';
  say('State unavailable');
}
async function load(){
  try{
    const res=await fetch('/state',{cache:'no-store'});
    if(!res.ok)throw new Error('HTTP '+res.status);
    const next=await res.json();
    if(!next||typeof next!=='object'||!next.repo)throw new Error('unreadable state');
    failures=0;
    document.querySelector('.top').classList.remove('down');
    // Repaint only when something changed, so the page does not flicker and a
    // reader does not lose their place every few seconds.
    const sig=JSON.stringify([next.repo,next.loop,next.backlog,next.findings,next.sprint,next.mode,next.progress]);
    d=next;
    if(sig!==lastSig){const first=lastSig==='';lastSig=sig;paint();if(!first)say('Updated');}
    else{document.getElementById('hdr').textContent=stamp();}
  }catch(e){
    // One blip during a restart is not an outage; a run of them is.
    if(++failures>=2)offline(e.message);
  }
}
buildNav();
load();setInterval(load,3000);
</script></body></html>`;

createServer((req, res) => {
  if (req.url === '/state') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(snapshot()));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(PAGE);
  // Loopback only: this exposes engineering state and is not authenticated.
}).listen(PORT, '127.0.0.1', () => {
  process.stdout.write(
    `\n  Engineering Control Center  http://127.0.0.1:${PORT}\n  Read-only, loopback only, reads .ai/ — Ctrl+C to stop\n\n`,
  );
});
