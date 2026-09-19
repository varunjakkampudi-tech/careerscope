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
    return execFileSync('git', ['log', '--since=14.days', '--format=%cI|%s'], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [when, ...rest] = l.split('|');
        return { date: when.slice(0, 10), subject: rest.join('|') };
      });
  } catch {
    return [];
  }
}

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>CareerScope Engineering</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
/* Command Centre (Refined Dark) — tokens from the approved concept. */
:root{--bg:#080B10;--surface:#0F141A;--panel:#141B22;--line:#1F2937;--ink:#F4F7FA;--muted:#AEB8C4;--ok:#2DD4A5;--warn:#F59E0B;--bad:#EF4444;--dim:#64748B;--unmeasured:#94A3B8;--focus:#7DE7CF;--hover:#151E26;color-scheme:dark}
html[data-theme=light]{--bg:#F5F7FA;--surface:#FFFFFF;--panel:#EEF2F5;--line:#D5DDE5;--ink:#10151B;--muted:#52606D;--ok:#0B7F68;--warn:#B45309;--bad:#DC2626;--dim:#64748B;--unmeasured:#6B7A8A;--focus:#0B7F68;--hover:#E9EEF2;color-scheme:light}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:400 13px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
header{padding:14px 24px;border-bottom:1px solid var(--line);display:flex;gap:16px;align-items:center;flex-wrap:wrap;background:var(--surface)}
.brand{display:inline-flex;align-items:center;gap:10px;font-weight:700;font-size:16px;letter-spacing:-.02em}
h1{font-size:28px;font-weight:700;letter-spacing:-.02em;margin:0 0 2px}
h2{font-size:20px;font-weight:600;letter-spacing:-.01em;margin:0 0 12px}
.sub{color:var(--muted);font-size:12px;font-weight:500;letter-spacing:.02em}
.grow{flex:1}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px}
nav{display:flex;gap:2px;padding:0 24px;border-bottom:1px solid var(--line);flex-wrap:wrap;background:var(--surface)}
nav button{background:none;border:0;border-bottom:2px solid transparent;color:var(--muted);padding:10px 12px;cursor:pointer;font:inherit;font-size:13px;font-weight:500}
nav button:hover{color:var(--ink)}
nav button[aria-selected=true]{color:var(--ink);border-bottom-color:var(--ok)}
main{padding:24px;display:grid;gap:24px;max-width:1440px;margin:0 auto}
.grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fill,minmax(190px,1fr))}
.card{background:var(--panel);border:1px solid var(--line);border-radius:4px;padding:12px 14px;transition:background 120ms ease-out}
.card:hover{background:var(--hover)}
.k{color:var(--muted);font-size:12px;font-weight:500;letter-spacing:.02em;text-transform:uppercase}
.v{font-size:22px;font-weight:600;letter-spacing:-.01em;margin-top:6px;font-variant-numeric:tabular-nums}
.note{color:var(--muted);font-size:12px;margin-top:4px;display:flex;align-items:center;gap:6px}
/* A breached or blocked value is never signalled by colour alone. */
.card.breach{border-color:var(--bad);border-left-width:3px}
.card.breach .v{color:var(--bad)}
.card.breach .note{color:var(--bad);font-weight:600}
.card.attn{border-color:var(--warn)}
.card.attn .v{color:var(--warn)}
.card.unmeasured .v{color:var(--unmeasured)}
table{width:100%;border-collapse:collapse}
td,th{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:middle}
tbody tr{height:52px}
tbody tr:hover{background:var(--hover)}
th{color:var(--muted);font-weight:500;font-size:12px;text-transform:uppercase;letter-spacing:.02em}
.ok{color:var(--ok)}.warn{color:var(--warn)}.bad{color:var(--bad)}.muted{color:var(--muted)}
.bar{height:8px;background:var(--surface);border:1px solid var(--line);border-radius:2px;overflow:hidden;min-width:120px}
.bar>i{display:block;height:100%;background:var(--ok)}
.bar>i.warn{background:var(--warn)}
.bar>i.bad{background:var(--bad)}
/* Unmeasured is not zero: hatching reads as "no data", an empty bar reads as 0%. */
.bar.none{background:repeating-linear-gradient(45deg,transparent,transparent 3px,var(--line) 3px,var(--line) 6px)}
.st{font-size:12px;font-weight:600;letter-spacing:.02em;white-space:nowrap}
.st.VERIFIED{color:var(--ok)}
.st.INPROGRESS{color:var(--warn)}
.st.UNMEASURED{color:var(--unmeasured)}
.st.BLOCKED{color:var(--bad)}
.st.NOTSTARTED{color:var(--dim)}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--dim);margin-right:8px;flex:0 0 auto}
.dot.live{background:var(--ok);animation:p 1s ease-in-out infinite}
.dot.ok{background:var(--ok)}.dot.warn{background:var(--warn)}.dot.bad{background:var(--bad)}
.spark{display:flex;align-items:flex-end;gap:3px;height:60px;margin-top:10px}
.spark>i{width:16px;flex:0 0 auto;background:var(--ok);opacity:.85;border-radius:1px}
.spark>i:hover{opacity:1}
.up{color:var(--ok)}.down{color:var(--bad)}.flat{color:var(--muted)}
.day{display:flex;justify-content:space-between;gap:12px;padding:6px 0;border-bottom:1px solid var(--line)}
.tag{font-size:12px;border:1px solid var(--line);border-radius:3px;padding:1px 6px;color:var(--muted)}
.fresh{outline:1px solid var(--ok);outline-offset:2px;border-radius:3px}
@keyframes p{0%,100%{opacity:1}50%{opacity:.25}}
@media (prefers-reduced-motion:reduce){.dot.live{animation:none}.card{transition:none}}
.empty{color:var(--muted);padding:10px 0}
.pill{border:1px solid var(--line);border-radius:999px;padding:1px 8px;font-size:12px;color:var(--muted)}
.cols{display:grid;gap:16px;grid-template-columns:minmax(0,1.6fr) minmax(0,1fr)}
@media (max-width:1023px){.cols{grid-template-columns:minmax(0,1fr)}}
.foot{display:flex;gap:10px;align-items:center;color:var(--muted);font-size:12px;border-top:1px solid var(--line);padding-top:12px}
.legend{display:grid;gap:8px}
.legend div{display:flex;align-items:center;gap:8px;font-size:12px}
</style></head><body>
<header>
<span class="brand"><svg width="20" height="20" viewBox="0 0 56 56" aria-hidden="true" fill="none"><path fill="currentColor" fill-rule="evenodd" d="M52 26C52 39.255 41.255 50 28 50C14.745 50 4 39.255 4 26C4 12.745 14.745 2 28 2C38.1 2 46.9 8.15 50.25 17H40.2C37.8 13.75 33.35 11 28 11C19.715 11 13 17.715 13 26C13 34.285 19.715 41 28 41C33.35 41 37.8 38.25 40.2 35H50.25C46.9 43.85 38.1 50 28 50Z"/><circle cx="39" cy="26" r="4.25" fill="currentColor"/></svg>CareerScope</span>
<span class="sub">Engineering Control Centre</span>
<span class="grow"></span>
<button id="theme" class="pill" style="cursor:pointer;background:none">Theme</button>
<span class="sub mono" id="hdr"></span>
</header>
<nav id="nav"></nav><main id="main"></main>
<script>
const TABS=['OVERVIEW','DAILY','SPRINT','BACKLOG','AGENTS','FINDINGS','RELEASES','RESEARCH','AUDIT'];
let tab='OVERVIEW',d={};
const esc=s=>String(s??'—').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const card=(k,v,cls='',note='')=>'<div class="card '+cls+'"><div class=k>'+k+'</div><div class="v">'+esc(v)+'</div>'+(note?'<div class=note>'+note+'</div>':'')+'</div>';
const dot=(c,t)=>'<span class="dot '+c+'"></span>'+esc(t);
function overview(){
  const f=d.findings.items||d.findings.findings||[];
  const open=f.filter(x=>x.status!=='FIXED'&&x.status!=='CLOSED');
  const n=s=>open.filter(x=>x.severity===s).length;
  const items=d.backlog.items||[];
  const active=items.filter(i=>['IN_PROGRESS','CODE_REVIEW','QA','SECURITY'].includes(i.status));
  const paused=d.mode&&d.mode.mode==='PAUSED';
  const dim=k=>items.filter(i=>i.dimension===k).length;
  const breached=active.length>2;
  const banner=paused
    ?'<div class="card attn"><div class=k>Sprint process paused until '+esc(d.mode.resumeOn||'further notice')+'</div><div style="margin-top:6px">'+esc(d.mode.reason||'')+'</div><div class=note>Resume when: '+esc(d.mode.resumeCondition||'unspecified')+'</div><div class=note>Agents and every safety gate remain active.</div></div>'
    :'';
  return '<div><h1>System status</h1><div class=sub>Real data. Read-only. Repaints every 3 seconds.</div></div>'+banner+'<div class=grid>'
    +card('Deployed',d.repo.version,'',dot('ok','Live on production'))
    +card('V1 line',d.repo.legacyVersion,'',dot('','Legacy data'))
    +card('Branch',d.repo.branch,d.repo.branch==='main'?'attn':'',dot(d.repo.branch==='main'?'warn':'ok',d.repo.branch==='main'?'Release line':'Feature branch'))
    +card('Commit',d.repo.commit)
    +card('Process mode',paused?'PAUSED':'ACTIVE',paused?'attn':'',paused?dot('warn','until '+esc(d.mode.resumeOn||'—')):dot('ok','Running'))
    +card('Sprint',d.sprint?d.sprint.sprintId:'not planned','',d.sprint?dot(d.sprint.status==='ACTIVE'?'ok':'warn',d.sprint.status||'—'):'')
    +card('Target release',d.sprint?d.sprint.targetReleaseDate:'—','',dot('','Planned'))
    +card('Scheduler',d.releasePlan.schedulerEnabled?'ENABLED':'Disabled',d.releasePlan.schedulerEnabled?'breach':'',dot(d.releasePlan.schedulerEnabled?'bad':'','Manual only'))
    +card('WIP',active.length+'/2',breached?'breach':'',breached?'&#9888; Limit breached':dot('ok','Within limit'))
    +card('Backlog total',items.length,'',dot('',dim('product')+' product / '+dim('engineering')+' eng'))
    +card('P0',n('P0'),n('P0')?'breach':'',n('P0')?'&#9888; Blocking':dot('ok','Clear'))
    +card('P1',n('P1'),n('P1')?'attn':'',dot(n('P1')?'warn':'ok',n('P1')?'Needs attention':'Clear'))
    +card('P2',n('P2'))
    +card('P3',n('P3'))
    +'</div>'
    +'<div class=cols><div>'+progress()+'</div><div>'+legend()+'</div></div>';
}
function legend(){
  const rows=[['ok','Verified'],['warn','In progress'],['bad','Blocked'],['','Not started'],['','Unmeasured']];
  return '<div class=card><div class=k>Status legend</div><div class=legend style="margin-top:10px">'
    +rows.map(r=>'<div>'+dot(r[0],r[1])+'</div>').join('')
    +'</div><div class=note style="margin-top:12px">Unmeasured shows an em dash and a hatched bar. It is not the same as zero.</div></div>';
}
function progress(){
  const a=d.progress.areas||[];if(!a.length)return '';
  const cls=x=>x.status==='VERIFIED'?'':x.status==='BLOCKED'?'bad':'warn';
  return '<div class=card><h2 style="margin:0 0 12px">Progress by area</h2><table>'+a.map(x=>{
    const none=x.percent===null||x.percent===undefined;
    const pct=none?'—':x.percent+'%';
    const fill=none?'<div class="bar none"></div>':'<div class=bar><i class="'+cls(x)+'" style="width:'+x.percent+'%"></i></div>';
    return '<tr><td style="width:150px">'+esc(x.area)+'</td><td>'+fill+'</td><td class=mono style="width:52px;text-align:right">'+pct+'</td><td style="width:110px"><span class="st '+String(x.status).replace(/[^A-Z]/g,'')+'">'+esc(x.status)+'</span></td></tr>';
  }).join('')+'</table></div>';
}
function sprint(){
  if(!d.sprint)return '<div class=card><div class=empty>No sprint planned for '+esc(d.week)+'. Run <code>npm run agile:plan</code>.</div></div>';
  const s=d.sprint;const days=['Mon Planning','Tue Build','Wed Integrate','Thu Release candidate','Fri Release + review'];
  return '<div class=card><div class=k>Sprint '+esc(s.sprintId)+' — '+esc(s.status)+'</div><div class=v>'+esc(s.goal||'no goal set')+'</div></div>'
   +'<div class=card><div class=k>Week</div><table>'+days.map(x=>'<tr><td>'+x+'</td></tr>').join('')+'</table></div>'
   +'<div class=grid>'+card('Selected',(s.selectedFeatures||[]).length)+card('Deferred',(s.deferredFeatures||[]).length)+card('Rejected',(s.rejectedFeatures||[]).length)+'</div>'
   +(d.scrum?'<div class=card><div class=k>Latest scrum '+esc(d.scrum.date)+'</div><table>'+((d.scrum.contributions||[]).map(c=>'<tr><td>'+esc(c.agent)+'</td><td>'+esc(c.note)+'</td></tr>').join('')||'<tr><td class=muted>No contributions recorded yet.</td></tr>')+'</table></div>':'');
}
function backlog(){
  const items=d.backlog.items||[];
  if(!items.length)return '<div class=card><div class=empty>Backlog is empty. Nothing has been fabricated to fill it.</div></div>';
  const cols=['IDEA','DISCOVERY','READY','PLANNED','IN_PROGRESS','CODE_REVIEW','QA','SECURITY','READY_FOR_RELEASE','RELEASED','BLOCKED'];
  return '<div class=grid>'+cols.map(c=>{const list=items.filter(i=>i.status===c);
    return '<div class=card><div class=k>'+c+' ('+list.length+')</div>'+(list.map(i=>'<div style="margin-top:10px"><b>'+esc(i.id)+'</b> '+esc(i.title)+(i.summary?'<div class=muted style="margin:4px 0;font-size:12px;line-height:1.45">'+esc(i.summary)+'</div>':'')+'<span class=pill>'+esc(i.size)+'</span> <span class=pill>'+esc(i.priority)+'</span> <span class=pill>'+esc(i.dimension||'?')+'</span>'+(i.carriedCount?' <span class=pill>carried '+esc(i.carriedCount)+'\u00d7</span>':'')+'</div>').join('')||'<div class=empty>\u2014</div>')+'</div>';}).join('')+'</div>';
}
function agents(){
  const st=d.loop.agents||{};
  const acted=Array.isArray(d.loop.activity)?d.loop.activity.length:0;
  const provenance=acted===0
    ?'operator-reported, never observed — no agent has executed'
    :'operator-reported, not probed — '+acted+' recorded handoff(s)';
  return '<div class=card><div class=k>'+d.agents.length+' agents — '+provenance+'</div><table>'
   +'<tr><th></th><th>Agent</th><th>State</th><th>Permission</th></tr>'
   +d.agents.map(a=>{const s=(st[a.id]||'WAITING').toUpperCase();
     const isLive=d.live&&d.loop.activeAgent===a.id;
     return '<tr><td><span class="dot'+(isLive?' live':'')+'"></span></td><td>'+esc(a.name)+'</td><td class="'+(s==='BLOCKED'||s==='FAILED'?'bad':s==='COMPLETE'||s==='PASSED'?'ok':'muted')+'">'+esc(d.stale&&d.loop.activeAgent===a.id?s+' — STALE':s)+'</td><td class=muted>'+esc(a.permission)+'</td></tr>';}).join('')
   +'</table></div>';
}
function findings(){
  const f=d.findings.items||d.findings.findings||[];
  if(!f.length)return '<div class=card><div class=empty>No findings recorded.</div></div>';
  return '<div class=card><table><tr><th>ID</th><th>Sev</th><th>Found by</th><th>File</th><th>What</th><th>Status</th></tr>'
   +f.map(x=>'<tr><td>'+esc(x.id)+'</td><td class="'+(x.severity==='P0'||x.severity==='P1'?'bad':'warn')+'">'+esc(x.severity)+'</td><td>'+esc(x.foundBy)+'</td><td class=muted>'+esc(x.file)+'</td><td>'+esc(x.what)+'</td><td>'+esc(x.status)+'</td></tr>').join('')+'</table></div>';
}
function releases(){
  const p=d.releasePlan;
  return '<div class=grid>'+card('Current',p.currentRelease?p.currentRelease.releaseId:'none')
   +card('Next',p.nextRelease?p.nextRelease.releaseId:'none')
   +card('History',(p.releaseHistory||[]).length)
   +card('Scheduler',p.schedulerEnabled?'ENABLED':'disabled',p.schedulerEnabled?'warn':'muted')+'</div>'
   +'<div class=card><div class=k>Release gate</div><div class=empty>Run <code>npm run release:gate</code>. It refuses by default; an absent field is a refusal, not a pass.</div></div>';
}
function research(){
  const c=d.discovery.candidates||[];
  return (c.length?'<div class=card><table><tr><th>ID</th><th>Title</th><th>Problem</th><th>Confidence</th></tr>'+c.map(x=>'<tr><td>'+esc(x.id)+'</td><td>'+esc(x.title)+'</td><td>'+esc(x.userProblem)+'</td><td>'+esc(x.confidence)+'</td></tr>').join('')+'</table></div>':'<div class=card><div class=empty>No candidates. Discovery has not run.</div></div>')
   +'<div class=card><div class=k>Skill registry</div><table>'+((d.skills.skills||[]).map(s=>'<tr><td>'+esc(s.name)+'</td><td class=muted>'+esc(s.securityReview)+'</td></tr>').join('')||'<tr><td class=muted>—</td></tr>')+'</table></div>';
}
function audit(){
  if(!d.runs.length)return '<div class=card><div class=empty>No recorded runs.</div></div>';
  return '<div class=card><table><tr><th>When</th><th>Phase</th><th>Result</th><th>Commit</th></tr>'
   +d.runs.map(r=>'<tr><td class=muted>'+esc(new Date(r.completedAt).toLocaleString())+'</td><td>'+esc(r.phase)+'</td><td class="'+(String(r.result).includes('block')||String(r.result).includes('exceed')?'bad':'')+'">'+esc(r.result)+'</td><td class=muted>'+esc((r.commit||'').slice(0,7))+'</td></tr>').join('')+'</table></div>';
}
function daily(){
  const h=d.history||[];
  if(!h.length)return '<div class=card><div class=empty>No progress history yet. Points appear once .ai/progress.json has been committed more than once — nothing is interpolated.</div></div>';
  const last=h[h.length-1],prev=h.length>1?h[h.length-2]:null;
  const delta=prev?last.overall-prev.overall:0;
  const max=Math.max(...h.map(p=>p.overall),1);
  const spark=h.length>1
    ?'<div class=spark>'+h.map(p=>'<i style="height:'+Math.max(6,(p.overall/max)*100)+'%" title="'+p.date+' — '+p.overall+'% ('+p.commit+')"></i>').join('')+'</div>'
    :'<div class=empty>One record so far — '+esc(last.date)+' at '+last.overall+'%. A trend needs a second commit to .ai/progress.json; nothing is interpolated to fill the gap.</div>';
  const areaRows=prev?Object.keys(last.areas).map(a=>{const n=last.areas[a],o=prev.areas[a];
    const c=o===undefined?0:n-o;
    return '<tr><td>'+esc(a)+'</td><td>'+n+'%</td><td class="'+(c>0?'up':c<0?'down':'flat')+'">'+(c>0?'+'+c:c===0?'—':c)+'%</td></tr>';}).join(''):'<tr><td class=muted colspan=3>Only one data point so far.</td></tr>';
  const byDay={};for(const a of (d.activity||[]))(byDay[a.date]=byDay[a.date]||[]).push(a.subject);
  const days=Object.keys(byDay).sort().reverse().slice(0,10);
  return '<div class=grid>'+card('Overall',last.overall+'%')
    +card('Change since last record',(delta>0?'+':'')+delta+'%',delta>0?'ok':delta<0?'bad':'muted')
    +card('Records',h.length)+card('Latest',last.date+'  '+last.commit)+'</div>'
   +'<div class=card><div class=k>Overall progress — one point per day that actually changed</div>'+spark+'</div>'
   +'<div class=card><div class=k>Per-area change since the previous record</div><table><tr><th>Area</th><th>Now</th><th>Change</th></tr>'+areaRows+'</table></div>'
   +'<div class=card><div class=k>Commits by day (last 14 days)</div>'+(days.length?days.map(x=>'<div class=day><span>'+esc(x)+'</span><span class=tag>'+byDay[x].length+' commits</span></div>'+byDay[x].slice(0,4).map(s=>'<div class=muted style="padding-left:12px;font-size:12px">'+esc(s)+'</div>').join('')).join(''):'<div class=empty>No commits in the last 14 days.</div>')+'</div>';
}
const VIEWS={OVERVIEW:overview,DAILY:daily,SPRINT:sprint,BACKLOG:backlog,AGENTS:agents,FINDINGS:findings,RELEASES:releases,RESEARCH:research,AUDIT:audit};
// The concept asks for staleness to be visible rather than implied, so the
// header says how old the reading is once it stops being current.
function stamp(){
  const age=Math.round((Date.now()-Date.parse(d.generatedAt))/1000);
  const when=new Date(d.generatedAt).toLocaleTimeString();
  return 'Local · 127.0.0.1:7777 · '+(age>60?'⏱ Stale — '+age+'s old':'auto-refresh 3s · '+when);
}
function paint(){
  document.getElementById('nav').innerHTML=TABS.map(t=>'<button aria-selected="'+(t===tab)+'" onclick="go(\\''+t+'\\')">'+t+'</button>').join('');
  document.getElementById('hdr').textContent=stamp();
  document.getElementById('main').innerHTML=VIEWS[tab]();
}
function go(t){tab=t;paint()}
document.getElementById('theme').addEventListener('click',()=>{
  const light=document.documentElement.getAttribute('data-theme')==='light';
  document.documentElement.setAttribute('data-theme',light?'dark':'light');
});
let lastSig='';
async function load(){
  try{
    const next=await (await fetch('/state')).json();
    // Repaint only when something actually changed, so the page does not flicker
    // and a reader does not lose their place every few seconds.
    const sig=JSON.stringify([next.repo,next.loop,next.backlog,next.findings,next.sprint,next.mode,next.progress,next.history&&next.history.length,next.runs&&next.runs.length]);
    d=next;
    if(sig!==lastSig){lastSig=sig;paint();
      const el=document.getElementById('hdr');el.classList.add('fresh');setTimeout(()=>el.classList.remove('fresh'),600);}
    else{document.getElementById('hdr').textContent=stamp();}
  }catch(e){document.getElementById('hdr').textContent='state unavailable — '+e.message;}
}
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
