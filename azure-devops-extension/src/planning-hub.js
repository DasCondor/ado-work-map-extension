// ADO Work Map - Sprint planning hub (Boards > Sprint planning).
//
// Reads the team's sprints, members, capacity and days off, and the work items, with the signed-in
// user's own access, then runs the planning page (planning-app.js, built from
// sprint-planning/sprint_planning.template.html). "Save plan" writes the changes back:
//   - sprint (iteration) and owner of stories, story points / effort
//   - new tasks, linked to their story
//   - capacity per day and days off per person, team days off
// Azure DevOps only stores whole days off, so partial days off (half a day, a few hours) are kept in
// the extension's own data storage for the team, where everyone using the hub sees them.
import * as SDK from './sdk/SDK.min.js';

const API = '7.1';
const STORY_TYPES = ['User Story', 'Technical Story', 'Product Backlog Item', 'Requirement', 'Bug'];
const LEVELS = {Epic: 0, Feature: 1, 'User Story': 2, 'Technical Story': 2, 'Product Backlog Item': 2, Requirement: 2, Bug: 2, Task: 3};
const POINT_FIELDS = ['Microsoft.VSTS.Scheduling.StoryPoints', 'Microsoft.VSTS.Scheduling.Effort', 'Microsoft.VSTS.Scheduling.Size'];
const PARTIAL = 'partial-days-off';          // extension data collection
const DAY = 864e5;

const $ = s => document.querySelector(s);
let ctx = null, calls = 0;
let byId = new Map(), sprints = [], members = [], origCap = {}, D = null;

function step(msg) {
  const s = $('#pl-step'), l = $('#pl-log');
  if (s) s.textContent = msg;
  if (l) { l.textContent += msg + '\n'; l.scrollTop = l.scrollHeight; }
}

// ---------------------------------------------------------------- REST
async function api(url, {method = 'GET', body, query, patch, noVersion} = {}) {
  const q = [];
  if (!noVersion) q.push('api-version=' + API);
  if (query) for (const [k, v] of Object.entries(query)) q.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(v)));
  const full = q.length ? url + (url.includes('?') ? '&' : '?') + q.join('&') : url;
  for (let attempt = 0; ; attempt++) {
    const token = await SDK.getAccessToken();
    calls++;
    const headers = {Authorization: 'Bearer ' + token, Accept: 'application/json'};
    if (body !== undefined) headers['Content-Type'] = patch ? 'application/json-patch+json' : 'application/json';
    let r;
    try { r = await fetch(full, {method, headers, body: body !== undefined ? JSON.stringify(body) : undefined}); }
    catch (e) { if (attempt < 2) continue; throw new Error(`${method} ${url.split('?')[0]}: ${e.message}`); }
    if ((r.status === 429 || r.status === 503) && attempt < 4) {
      await new Promise(res => setTimeout(res, 1000 * Math.min(30, Number(r.headers.get('Retry-After')) || 2 * (attempt + 1))));
      continue;
    }
    if (!r.ok) {
      let detail = '';
      try { const t = await r.text(); try { detail = JSON.parse(t).message || t; } catch (e) { detail = t; } } catch (e) {}
      const err = new Error(String(detail || r.statusText).slice(0, 300));
      err.status = r.status;
      throw err;
    }
    return r.status === 204 ? null : r.json();
  }
}
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({length: Math.min(n, items.length)}, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}
const chunks = (list, size) => { const out = []; for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size)); return out; };
const wq = s => String(s).replace(/'/g, "''");
const ymd = t => new Date(t).toISOString().slice(0, 10);
const teamUrl = () => `${ctx.projUrl}/${encodeURIComponent(ctx.teamId)}`;

// Rich text from work items (description, acceptance criteria): only plain formatting is kept
const ALLOWED = new Set(['P', 'BR', 'DIV', 'SPAN', 'UL', 'OL', 'LI', 'B', 'STRONG', 'I', 'EM', 'U', 'A', 'H1', 'H2', 'H3', 'H4', 'CODE', 'PRE',
  'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH', 'BLOCKQUOTE', 'HR']);
const DROP = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'MATH', 'FORM', 'INPUT', 'BUTTON', 'TEXTAREA', 'SELECT']);
function sanitize(html) {
  if (!html) return '';
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
  const root = doc.body.firstElementChild;
  // Unknown tags become their plain text; every attribute goes, except http(s) links on <a>
  const walk = el => {
    for (const child of [...el.children]) {
      if (DROP.has(child.tagName)) { child.remove(); continue; }
      if (!ALLOWED.has(child.tagName)) { child.replaceWith(doc.createTextNode(child.textContent)); continue; }
      const href = child.tagName === 'A' ? child.getAttribute('href') || '' : '';
      for (const a of [...child.attributes]) child.removeAttribute(a.name);
      if (/^https?:\/\//i.test(href)) { child.setAttribute('href', href); child.setAttribute('target', '_blank'); child.setAttribute('rel', 'noopener noreferrer'); }
      walk(child);
    }
  };
  walk(root);
  return root.innerHTML;
}

// ---------------------------------------------------------------- read
async function context() {
  SDK.init({loaded: false});
  await SDK.ready();
  const wc = SDK.getWebContext(), host = SDK.getHost();
  let base = '';
  try { base = await (await SDK.getService('ms.vss-features.location-service')).getServiceLocation(); } catch (e) {}
  if (!base) base = `https://dev.azure.com/${encodeURIComponent(host.name)}/`;
  const baseUrl = String(base).replace(/\/+$/, '');
  ctx = {org: host.name, project: wc.project.name, projectId: wc.project.id, baseUrl, projUrl: `${baseUrl}/${encodeURIComponent(wc.project.name)}`,
    teamId: wc.team && wc.team.id ? wc.team.id : '', teamName: wc.team && wc.team.name ? wc.team.name : ''};
  if (!ctx.teamId) {
    const teams = (await api(`${ctx.baseUrl}/_apis/projects/${ctx.projectId}/teams`, {query: {$top: 1}})).value || [];
    if (!teams.length) throw new Error('This project has no teams.');
    ctx.teamId = teams[0].id; ctx.teamName = teams[0].name;
  }
  SDK.notifyLoadSucceeded();
}

const dayList = (start, finish) => { const out = []; if (!start || !finish) return out;
  for (let t = Date.parse(start.slice(0, 10) + 'T00:00:00Z'); t <= Date.parse(finish.slice(0, 10) + 'T00:00:00Z'); t += DAY) { const w = new Date(t).getUTCDay(); if (w && w < 6) out.push(ymd(t)); }
  return out; };
const rangesToDays = (ranges, days) => { const set = new Set(); for (const r of ranges || []) { const a = String(r.start).slice(0, 10), b = String(r.end).slice(0, 10); days.forEach(d => { if (d >= a && d <= b) set.add(d); }); } return set; };

async function extData() {
  try {
    const svc = await SDK.getService('ms.vss-features.extension-data-service');
    return await svc.getExtensionDataManager(SDK.getExtensionContext().id, await SDK.getAccessToken());
  } catch (e) { return null; }
}

async function load() {
  step('Connecting to Azure DevOps...');
  await context();
  step(`Reading ${ctx.teamName}'s sprints, areas and members...`);
  const [its, tfv, mem] = await Promise.all([
    api(`${teamUrl()}/_apis/work/teamsettings/iterations`),
    api(`${teamUrl()}/_apis/work/teamsettings/teamfieldvalues`),
    api(`${ctx.baseUrl}/_apis/projects/${ctx.projectId}/teams/${ctx.teamId}/members`, {query: {$top: 500}})
  ]);
  sprints = (its.value || []).map(it => {
    const a = it.attributes || {};
    return {id: it.id, name: it.name, path: it.path, start: a.startDate || '', finish: a.finishDate || '', timeFrame: String(a.timeFrame || '').toLowerCase()};
  }).sort((a, b) => (a.start || '9999') < (b.start || '9999') ? -1 : 1);
  if (!sprints.length) throw new Error(`${ctx.teamName} has no sprints selected. Pick the team's sprints in Project settings > Team configuration > Iterations.`);
  members = (mem.value || []).map(m => m.identity || m).filter(i => i && !i.isContainer)
    .map(i => ({name: i.displayName, uniqueName: i.uniqueName, id: i.id}));

  // Work items in the team's area: open ones, plus anything changed in the last 120 days (for velocity)
  const field = (tfv.field && tfv.field.referenceName) || 'System.AreaPath';
  const areas = (tfv.values || []).map(v => `[${field}] ${v.includeChildren ? 'UNDER' : '='} '${wq(v.value)}'`);
  const areaClause = areas.length ? `(${areas.join(' OR ')})` : '1 = 1';
  const types = STORY_TYPES.concat(['Task', 'Feature', 'Epic']).map(t => `'${wq(t)}'`).join(', ');
  const base = `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.WorkItemType] IN (${types}) AND [System.State] <> 'Removed' AND ${areaClause}`;
  step('Finding work items...');
  const [open, recent] = await Promise.all([
    api(`${ctx.projUrl}/_apis/wit/wiql`, {method: 'POST', body: {query: base + ` AND [System.State] NOT IN ('Closed', 'Done', 'Completed', 'Cut')`}}),
    api(`${ctx.projUrl}/_apis/wit/wiql`, {method: 'POST', body: {query: base + ` AND [System.ChangedDate] >= @today - 120`}})
  ]);
  const ids = [...new Set([...(open.workItems || []), ...(recent.workItems || [])].map(w => w.id))];
  const raw = [];
  let n = 0;
  await pool(chunks(ids, 200), 4, async chunk => {
    const res = await api(`${ctx.projUrl}/_apis/wit/workitemsbatch`, {method: 'POST', body: {ids: chunk, $expand: 'Relations', errorPolicy: 'Omit'}});
    for (const w of res.value || []) if (w) raw.push(w);
    n += chunk.length; step(`Reading work items: ${n.toLocaleString()} / ${ids.length.toLocaleString()}`);
  });

  // State categories, for done / in progress / not started
  const typeNames = [...new Set(raw.map(w => w.fields['System.WorkItemType']))];
  const cats = {};
  await pool(typeNames, 4, async t => { try { for (const s of (await api(`${ctx.projUrl}/_apis/wit/workitemtypes/${encodeURIComponent(t)}/states`)).value || []) cats[`${t}|${s.name}`] = s.category; } catch (e) {} });
  const bucket = (t, s) => { const c = cats[`${t}|${s}`]; return c === 'Completed' ? 'done' : c === 'Removed' ? 'removed' : c === 'Proposed' ? 'new' : c ? 'active' :
    /^(done|closed|completed)$/i.test(s) ? 'done' : /^(new|proposed|to do|approved)$/i.test(s) ? 'new' : 'active'; };

  const idOf = url => { const m = /\/(\d+)$/.exec(String(url)); return m ? +m[1] : null; };
  const edges = [];
  const items = raw.map(w => {
    const f = w.fields, t = f['System.WorkItemType'], pf = POINT_FIELDS.find(k => f[k] != null) || null;
    let parent = null;
    for (const r of w.relations || []) {
      if (r.rel === 'System.LinkTypes.Hierarchy-Reverse') parent = idOf(r.url);
      if (r.rel === 'System.LinkTypes.Dependency-Forward') { const to = idOf(r.url); if (to) edges.push({from: 'w' + w.id, to: 'w' + to, kind: 'depends'}); }
    }
    const who = f['System.AssignedTo'];
    return {
      id: w.id, rev: w.rev, type: t, kind: STORY_TYPES.includes(t) && t !== 'Bug' ? 'Story' : t, level: LEVELS[t] == null ? 2 : LEVELS[t],
      title: f['System.Title'] || '', state: f['System.State'] || '', bucket: bucket(t, f['System.State']),
      assignee: who ? who.displayName || '' : '', assigneeUnique: who ? who.uniqueName || '' : '',
      iteration: f['System.IterationPath'] || '', area: f['System.AreaPath'] || '', tags: f['System.Tags'] || '',
      points: pf ? f[pf] : null, pointsField: pf, remaining: f['Microsoft.VSTS.Scheduling.RemainingWork'] == null ? null : f['Microsoft.VSTS.Scheduling.RemainingWork'],
      descHtml: sanitize(f['System.Description'] || f['Microsoft.VSTS.TCM.ReproSteps'] || ''), acHtml: sanitize(f['Microsoft.VSTS.Common.AcceptanceCriteria'] || ''),
      parent, children: [], url: `${ctx.projUrl}/_workitems/edit/${w.id}`
    };
  });
  byId = new Map(items.map(i => [i.id, i]));
  items.forEach(i => { if (i.parent && byId.has(i.parent)) byId.get(i.parent).children.push(i.id); else if (i.parent && !byId.has(i.parent)) i.parent = null; });

  // Capacity and days off for the current and upcoming sprints
  const capIdx = sprints.map((s, i) => i).filter(i => sprints[i].timeFrame !== 'past');
  const store = await extData();
  const capacity = {};
  await pool(capIdx, 3, async i => {
    const s = sprints[i], days = dayList(s.start, s.finish);
    step(`Reading capacity for ${s.name}...`);
    const [capRes, teamOff] = await Promise.all([
      api(`${teamUrl()}/_apis/work/teamsettings/iterations/${s.id}/capacities`).catch(() => ({teamMembers: []})),
      api(`${teamUrl()}/_apis/work/teamsettings/iterations/${s.id}/teamdaysoff`).catch(() => ({daysOff: []}))
    ]);
    const rows = capRes.teamMembers || capRes.value || [];
    const c = {hpd: {}, off: {}, team: {}, raw: {}};
    for (const r of rows) {
      const m = r.teamMember || {}; if (!m.displayName) continue;
      c.hpd[m.displayName] = (r.activities || []).reduce((a, x) => a + (+x.capacityPerDay || 0), 0);
      c.raw[m.displayName] = {id: m.id, activities: r.activities || []};
      const off = {}; rangesToDays(r.daysOff, days).forEach(d => { off[d] = 'full'; });
      if (Object.keys(off).length) c.off[m.displayName] = off;
    }
    members.forEach(m => { if (c.hpd[m.name] == null) { c.hpd[m.name] = 0; c.raw[m.name] = {id: m.id, activities: []}; } });
    rangesToDays(teamOff.daysOff, days).forEach(d => { c.team[d] = 'full'; });
    // partial days off kept by this extension
    if (store) { try { const doc = await store.getDocument(PARTIAL, `${ctx.teamId}.${s.id}`);
      for (const [who, map] of Object.entries((doc && doc.off) || {})) for (const [d, code] of Object.entries(map)) { if (!c.off[who] || c.off[who][d] !== 'full') (c.off[who] = c.off[who] || {})[d] = code; }
      for (const [d, code] of Object.entries((doc && doc.team) || {})) if (c.team[d] !== 'full') c.team[d] = code;
    } catch (e) { /* no document yet */ } }
    capacity[i] = c;
  });
  origCap = JSON.parse(JSON.stringify(capacity));
  for (const c of Object.values(capacity)) delete c.raw;
  D = {real: true, org: ctx.org, project: ctx.project, teamId: ctx.teamId, team: ctx.teamName, sprints, items, graph: {edges},
    people: members.map(m => ({name: m.name})), capacity};
  step(`${items.length.toLocaleString()} work items, ${sprints.length} sprints, ${members.length} team members - ${calls} calls`);
  return D;
}

// ---------------------------------------------------------------- write
const identity = name => { if (!name) return ''; const m = members.find(x => x.name === name); if (m) return m.uniqueName || m.name;
  const it = [...byId.values()].find(x => x.assignee === name && x.assigneeUnique); return it ? it.assigneeUnique : name; };
const iterPath = sp => sp >= 0 ? sprints[sp].path : ctx.project;

// What differs between the plan's capacity and what Azure DevOps has
function capacityChanges(C) {
  const out = [];
  for (const [k, c] of Object.entries(C || {})) {
    const i = +k, o = origCap[i]; if (!o || !c) continue;
    const days = dayList(sprints[i].start, sprints[i].finish);
    const full = (map, who) => days.filter(d => ((who ? (map[who] || {}) : map)[d]) === 'full').join(',');
    const part = (map, who) => JSON.stringify(Object.entries(who ? (map[who] || {}) : map).filter(([d, v]) => v !== 'full' && days.includes(d)).sort());
    for (const who of Object.keys(o.raw || {})) {
      const hpd = c.hpd[who] == null ? o.hpd[who] : c.hpd[who];
      if (hpd !== o.hpd[who] || full(c.off, who) !== full(o.off, who)) out.push({sp: i, kind: 'member', who});
      if (part(c.off, who) !== part(o.off, who)) out.push({sp: i, kind: 'partial', who});
    }
    if (full(c.team) !== full(o.team)) out.push({sp: i, kind: 'team'});
    if (part(c.team) !== part(o.team)) out.push({sp: i, kind: 'partial', who: ''});
  }
  return out;
}

async function save(plan) {
  const res = {saved: {moves: [], estimates: [], tasks: [], capacity: false}, errors: []};
  // 1. Stories: sprint, owner and points in one update each, guarded by revision so nobody's newer change is overwritten
  const ops = new Map(), add = (id, op) => { if (!ops.has(id)) ops.set(id, []); ops.get(id).push(op); };
  for (const m of plan.moves) { const it = byId.get(m.id); if (!it) continue;
    if (m.sp !== spOf(it)) add(m.id, {op: 'add', path: '/fields/System.IterationPath', value: iterPath(m.sp)});
    if (m.who !== (it.assignee || '')) add(m.id, {op: 'add', path: '/fields/System.AssignedTo', value: identity(m.who)}); }
  for (const e of plan.estimates) { const it = byId.get(e.id); if (it) add(e.id, {op: 'add', path: '/fields/' + (it.pointsField || 'Microsoft.VSTS.Scheduling.StoryPoints'), value: e.pts}); }
  await pool([...ops.keys()], 4, async id => {
    const it = byId.get(id);
    try {
      await api(`${ctx.projUrl}/_apis/wit/workitems/${id}`, {method: 'PATCH', patch: true, body: [{op: 'test', path: '/rev', value: it.rev}, ...ops.get(id)]});
      if (plan.moves.some(m => m.id === id)) res.saved.moves.push(id);
      if (plan.estimates.some(e => e.id === id)) res.saved.estimates.push(id);
    }
    catch (e) { res.errors.push(`#${id} ${it.title}: ${(e.status === 400 || e.status === 409 || e.status === 412) && /\brev\b|test operation|changed/i.test(e.message) ? 'changed by someone else since you opened the hub - reload and try again' : e.message}`); }
  });
  // 2. New tasks, linked to their story
  await pool(plan.tasks, 3, async (t, k) => {
    const st = byId.get(t.parent);
    const body = [
      {op: 'add', path: '/fields/System.Title', value: t.title},
      {op: 'add', path: '/fields/System.IterationPath', value: iterPath(t.sp)},
      {op: 'add', path: '/fields/System.AreaPath', value: st ? st.area : ctx.project},
      {op: 'add', path: '/fields/Microsoft.VSTS.Scheduling.RemainingWork', value: t.hrs},
      {op: 'add', path: '/relations/-', value: {rel: 'System.LinkTypes.Hierarchy-Reverse', url: `${ctx.baseUrl}/_apis/wit/workItems/${t.parent}`}}];
    if (t.who) body.push({op: 'add', path: '/fields/System.AssignedTo', value: identity(t.who)});
    try { await api(`${ctx.projUrl}/_apis/wit/workitems/$Task`, {method: 'POST', patch: true, body}); res.saved.tasks.push(k); }
    catch (e) { res.errors.push(`New task "${t.title}": ${e.message}`); }
  });
  // 3. Capacity: per person (hours per day and whole days off), team days off, partial days off
  const changes = capacityChanges(plan.capacity), store = changes.some(x => x.kind === 'partial') ? await extData() : null;
  let capOk = true;
  for (const ch of changes) {
    const s = sprints[ch.sp], c = plan.capacity[ch.sp], o = origCap[ch.sp], days = dayList(s.start, s.finish);
    const ranges = map => days.filter(d => map[d] === 'full').map(d => ({start: d + 'T00:00:00Z', end: d + 'T00:00:00Z'}));
    try {
      if (ch.kind === 'member') {
        const raw = o.raw[ch.who], hpd = c.hpd[ch.who] == null ? o.hpd[ch.who] : c.hpd[ch.who];
        let acts = (raw.activities || []).map(a => ({name: a.name || '', capacityPerDay: +a.capacityPerDay || 0}));
        if (!acts.length) acts = [{name: '', capacityPerDay: hpd}];
        else { const rest = acts.slice(1).reduce((a, x) => a + x.capacityPerDay, 0); acts[0].capacityPerDay = Math.max(0, hpd - rest); }
        await api(`${teamUrl()}/_apis/work/teamsettings/iterations/${s.id}/capacities/${raw.id}`, {method: 'PATCH', body: {activities: acts, daysOff: ranges(c.off[ch.who] || {})}});
      }
      else if (ch.kind === 'team') await api(`${teamUrl()}/_apis/work/teamsettings/iterations/${s.id}/teamdaysoff`, {method: 'PATCH', body: {daysOff: ranges(c.team)}});
      else if (ch.kind === 'partial') {
        if (!store) throw new Error('extension storage is not available');
        const keep = map => Object.fromEntries(Object.entries(map || {}).filter(([d, v]) => v !== 'full' && days.includes(d)));
        const doc = {id: `${ctx.teamId}.${s.id}`, __etag: -1, off: Object.fromEntries(Object.keys(o.raw).map(w => [w, keep(c.off[w])]).filter(([, m]) => Object.keys(m).length)), team: keep(c.team)};
        await store.setDocument(PARTIAL, doc);
      }
    }
    catch (e) { capOk = false; res.errors.push(`Capacity for ${ch.who || 'the team'} in ${s.name}: ${e.message}`); }
  }
  res.saved.capacity = capOk && changes.length > 0;
  return res;
}
const spOf = it => { let p = (it.iteration || '').toLowerCase();
  for (;;) { const i = sprints.findIndex(s => s.path.toLowerCase() === p); if (i >= 0) return i; const k = p.lastIndexOf('\\'); if (k < 0) return -1; p = p.slice(0, k); } };

async function openWorkItem(id) {
  try { (await SDK.getService('ms.vss-work-web.work-item-form-navigation-service')).openWorkItem(id, false); }
  catch (e) { window.open(`${ctx.projUrl}/_workitems/edit/${id}`, '_blank', 'noopener'); }
}

// ---------------------------------------------------------------- start
(async () => {
  try {
    const data = await load();
    window.PLANNING_API = {save, capacityChanges, openWorkItem, team: ctx.teamName};
    $('#pl-loading').hidden = true;
    window.runPlanning(data);
  }
  catch (e) {
    console.error(e);
    $('#pl-step').textContent = "Couldn't load from Azure DevOps.";
    const msg = $('#pl-error'); msg.hidden = false;
    msg.textContent = (e && e.message) || String(e);
  }
})();
