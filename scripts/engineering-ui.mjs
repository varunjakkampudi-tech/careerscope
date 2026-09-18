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
:root{--bg:#0d1117;--panel:#161b22;--line:#30363d;--ink:#e6edf3;--muted:#8b949e;--ok:#3fb950;--warn:#d29922;--bad:#f85149;--live:#58a6ff}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}
header{padding:16px 20px;border-bottom:1px solid var(--line);display:flex;gap:20px;align-items:baseline;flex-wrap:wrap}
h1{font-size:15px;margin:0;letter-spacing:.08em}
nav{display:flex;gap:4px;padding:8px 20px;border-bottom:1px solid var(--line);flex-wrap:wrap}
nav button{background:none;border:1px solid transparent;color:var(--muted);padding:5px 10px;cursor:pointer;font:inherit;border-radius:6px}
nav button[aria-selected=true]{color:var(--ink);border-color:var(--line);background:var(--panel)}
main{padding:20px;display:grid;gap:16px}
.grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fill,minmax(230px,1fr))}
.card{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:12px}
.k{color:var(--muted);font-size:11px;letter-spacing:.08em;text-transform:uppercase}
.v{font-size:19px;margin-top:4px}
table{width:100%;border-collapse:collapse}
td,th{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-weight:400;font-size:11px;text-transform:uppercase;letter-spacing:.06em}
.ok{color:var(--ok)}.warn{color:var(--warn)}.bad{color:var(--bad)}.muted{color:var(--muted)}
.bar{height:6px;background:#21262d;border-radius:3px;overflow:hidden;margin-top:6px}
.bar>i{display:block;height:100%;background:var(--ok)}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--muted);margin-right:8px}
.dot.live{background:var(--live);animation:p 1s ease-in-out infinite}
.spark{display:flex;align-items:flex-end;gap:3px;height:80px;margin-top:10px;justify-content:flex-start}
.spark>i{width:22px;flex:0 0 auto;background:linear-gradient(180deg,var(--live),#1f6feb);border-radius:2px 2px 0 0}
.spark>i:hover{background:var(--ok)}
.up{color:var(--ok)}.down{color:var(--bad)}.flat{color:var(--muted)}
.day{display:flex;justify-content:space-between;gap:12px;padding:5px 0;border-bottom:1px solid var(--line)}
.tag{font-size:10px;border:1px solid var(--line);border-radius:4px;padding:0 5px;color:var(--muted)}
.fresh{outline:1px solid var(--live);outline-offset:2px;border-radius:4px}
@keyframes p{0%,100%{opacity:1}50%{opacity:.25}}
@media (prefers-reduced-motion:reduce){.dot.live{animation:none}}
.empty{color:var(--muted);padding:10px 0}
.pill{border:1px solid var(--line);border-radius:999px;padding:1px 8px;font-size:11px;color:var(--muted)}
</style></head><body>
<header><h1>CAREERSCOPE ENGINEERING</h1><span id="hdr" class="muted"></span></header>
<nav id="nav"></nav><main id="main"></main>
<script>
const TABS=['OVERVIEW','DAILY','SPRINT','BACKLOG','AGENTS','FINDINGS','RELEASES','RESEARCH','AUDIT'];
let tab='OVERVIEW',d={};
const esc=s=>String(s??'—').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const card=(k,v,cls='')=>'<div class=card><div class=k>'+k+'</div><div class="v '+cls+'">'+esc(v)+'</div></div>';
function overview(){
  const f=d.findings.items||d.findings.findings||[];
  const open=f.filter(x=>x.status!=='FIXED'&&x.status!=='CLOSED');
  const n=s=>open.filter(x=>x.severity===s).length;
  const active=(d.backlog.items||[]).filter(i=>['IN_PROGRESS','CODE_REVIEW','QA','SECURITY'].includes(i.status));
  return '<div class=grid>'
    +card('Version (deployed)',d.repo.version)+card('V1 line',d.repo.legacyVersion,'muted')
    +card('Branch',d.repo.branch,d.repo.branch==='main'?'warn':'')
    +card('Commit',d.repo.commit)+card('Sprint',d.sprint?d.sprint.sprintId:'not planned')
    +card('Sprint goal',d.sprint&&d.sprint.goal?d.sprint.goal:'—')
    +card('Target release',d.sprint?d.sprint.targetReleaseDate:'—')
    +card('WIP',active.length+'/2',active.length>2?'bad':'')
    +card('Open P0',n('P0'),n('P0')?'bad':'ok')+card('Open P1',n('P1'),n('P1')?'bad':'ok')
    +card('Open P2',n('P2'))+card('Open P3',n('P3'))
    +card('Scheduler',d.releasePlan.schedulerEnabled?'ENABLED':'disabled',d.releasePlan.schedulerEnabled?'warn':'muted')
    +'</div>'+progress();
}
function progress(){
  const a=d.progress.areas||[];if(!a.length)return '';
  return '<div class=card><div class=k>Progress</div><table>'+a.map(x=>
    '<tr><td>'+esc(x.area)+'</td><td style="width:60%"><div class=bar><i style="width:'+x.percent+'%"></i></div></td><td>'+x.percent+'%</td><td class=muted>'+esc(x.status)+'</td></tr>').join('')+'</table></div>';
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
    return '<div class=card><div class=k>'+c+' ('+list.length+')</div>'+(list.map(i=>'<div style="margin-top:8px"><b>'+esc(i.id)+'</b> '+esc(i.title)+'<br><span class=pill>'+esc(i.size)+'</span> <span class=pill>'+esc(i.priority)+'</span></div>').join('')||'<div class=empty>—</div>')+'</div>';}).join('')+'</div>';
}
function agents(){
  const st=d.loop.agents||{};
  return '<div class=card><div class=k>'+d.agents.length+' agents — state is REPORTED by the orchestrator, not probed</div><table>'
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
function paint(){
  document.getElementById('nav').innerHTML=TABS.map(t=>'<button aria-selected="'+(t===tab)+'" onclick="go(\\''+t+'\\')">'+t+'</button>').join('');
  document.getElementById('hdr').textContent=d.repo.branch+' @ '+d.repo.commit+'  ·  '+d.week+'  ·  '+new Date(d.generatedAt).toLocaleTimeString();
  document.getElementById('main').innerHTML=VIEWS[tab]();
}
function go(t){tab=t;paint()}
let lastSig='';
async function load(){
  try{
    const next=await (await fetch('/state')).json();
    // Repaint only when something actually changed, so the page does not flicker
    // and a reader does not lose their place every few seconds.
    const sig=JSON.stringify([next.repo,next.loop,next.backlog,next.findings,next.sprint,next.history&&next.history.length,next.runs&&next.runs.length]);
    d=next;
    if(sig!==lastSig){lastSig=sig;paint();
      const el=document.getElementById('hdr');el.classList.add('fresh');setTimeout(()=>el.classList.remove('fresh'),600);}
    else{document.getElementById('hdr').textContent=d.repo.branch+' @ '+d.repo.commit+'  ·  '+d.week+'  ·  '+new Date(d.generatedAt).toLocaleTimeString();}
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
