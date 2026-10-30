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
let byId = new Map(), sprints = [], members = [], origCap = {}, D = null, capWarnings = [];

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
    catch (e) {   // network error: retry reads only; a write may have gone through, so repeating it could do it twice
      if (attempt < 2 && method === 'GET') continue;
      const err = new Error(`${method} ${url.split('?')[0]}: ${e.message}`); err.uncertain = method !== 'GET'; throw err;
    }
    if ((r.status === 429 || r.status === 503) && attempt < 4 && method === 'GET') {
      await new Promise(res => setTimeout(res, 1000 * Math.min(30, Number(r.headers.get('Retry-After')) || 2 * (attempt + 1))));
      continue;
    }
    if (!r.ok) {
      let detail = '';
      try { const t = await r.text(); try { detail = JSON.parse(t).message || t; } catch (e) { detail = t; } } catch (e) {}
      const err = new Error(r.status === 429 ? 'Azure DevOps is busy (too many requests), so nothing was changed. Try again in a minute.' : String(detail || r.statusText).slice(0, 300));
      err.status = r.status;
      if (r.status === 503 && method !== 'GET') err.uncertain = true;   // may or may not have been applied
      throw err;
    }
    if (r.status === 204) return null;
    try { return await r.json(); }
    catch (e) {   // the request went through but its answer can't be read: for a write, the outcome is unknown
      const err = new Error(`${method} ${url.split('?')[0]}: the answer from Azure DevOps couldn't be read (${e.message})`); err.uncertain = method !== 'GET'; throw err;
    }
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
const dayRanges = list => (list || []).map(r => [String(r.start).slice(0, 10), String(r.end).slice(0, 10)]).sort().join(';');
const normTitle = s => String(s || '').trim().toLowerCase();
// Tasks you created under these stories since a date, by story: [{id, title, who, hrs, iteration, created}]
async function tasksMadeSince(parents, since) {
  const out = new Map();
  for (const ids of chunks(parents, 200)) {
    const q = `SELECT [System.Id] FROM WorkItemLinks WHERE [Source].[System.Id] IN (${ids.join(',')}) AND [System.Links.LinkType] = 'System.LinkTypes.Hierarchy-Forward' ` +
      `AND [Target].[System.WorkItemType] = 'Task' AND [Target].[System.CreatedBy] = @me AND [Target].[System.CreatedDate] >= '${since.slice(0, 10)}' MODE (MustContain)`;
    const rel = ((await api(`${ctx.projUrl}/_apis/wit/wiql`, {method: 'POST', body: {query: q}})).workItemRelations || []).filter(r => r.source && r.target);
    for (const part of chunks(rel, 200)) {
      const ws = (await api(`${ctx.baseUrl}/_apis/wit/workitemsbatch`, {method: 'POST', body: {ids: part.map(r => r.target.id),
        fields: ['System.Title', 'System.AssignedTo', 'Microsoft.VSTS.Scheduling.RemainingWork', 'System.IterationPath', 'System.CreatedDate']}})).value || [];
      const byTask = new Map(ws.map(w => [w.id, w.fields || {}]));
      for (const r of part) { const f = byTask.get(r.target.id); if (!f) continue;
        if (!out.has(r.source.id)) out.set(r.source.id, []);
        out.get(r.source.id).push({id: r.target.id, title: normTitle(f['System.Title']), who: f['System.AssignedTo'] ? f['System.AssignedTo'].displayName || '' : '',
          hrs: +f['Microsoft.VSTS.Scheduling.RemainingWork'] || 0, iteration: String(f['System.IterationPath'] || '').toLowerCase(), created: Date.parse(f['System.CreatedDate'] || 0)}); }
    }
  }
  return out;
}
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
      iteration: f['System.IterationPath'] || '', area: f['System.AreaPath'] || '', tags: f['System.Tags'] || '', lane: f['System.BoardLane'] || '',
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
    let failed = '';
    const [capRes, teamOff] = await Promise.all([
      api(`${teamUrl()}/_apis/work/teamsettings/iterations/${s.id}/capacities`).catch(e => { failed = failed || e.message; return null; }),
      api(`${teamUrl()}/_apis/work/teamsettings/iterations/${s.id}/teamdaysoff`).catch(e => { failed = failed || e.message; return null; })
    ]);
    const rows = capRes ? capRes.teamMembers || capRes.value || [] : [];
    // unread: shown as 0 hours but never saved, so a failed read can't overwrite the real capacity
    const c = {hpd: {}, off: {}, team: {}, raw: {}, unread: !!failed, teamRaw: teamOff ? teamOff.daysOff || [] : [], etag: null};
    if (failed) capWarnings.push(`${s.name}: capacity couldn't be read from Azure DevOps (${failed}). It shows as 0 hours, and capacity changes for this sprint won't be saved.`);
    for (const r of rows) {
      const m = r.teamMember || {}; if (!m.displayName) continue;
      c.hpd[m.displayName] = (r.activities || []).reduce((a, x) => a + (+x.capacityPerDay || 0), 0);
      c.raw[m.displayName] = {id: m.id, activities: r.activities || [], daysOff: r.daysOff || []};
      const off = {}; rangesToDays(r.daysOff, days).forEach(d => { off[d] = 'full'; });
      if (Object.keys(off).length) c.off[m.displayName] = off;
    }
    members.forEach(m => { if (c.hpd[m.name] == null) { c.hpd[m.name] = 0; c.raw[m.name] = {id: m.id, activities: [], daysOff: []}; } });
    rangesToDays(teamOff ? teamOff.daysOff : [], days).forEach(d => { c.team[d] = 'full'; });
    // partial days off kept by this extension
    if (store) { try { const doc = await store.getDocument(PARTIAL, `${ctx.teamId}.${s.id}`); c.etag = doc ? doc.__etag : null;
      for (const [who, map] of Object.entries((doc && doc.off) || {})) for (const [d, code] of Object.entries(map)) { if (!c.off[who] || c.off[who][d] !== 'full') (c.off[who] = c.off[who] || {})[d] = code; }
      for (const [d, code] of Object.entries((doc && doc.team) || {})) if (c.team[d] !== 'full') c.team[d] = code;
    } catch (e) { /* no document yet */ } }
    capacity[i] = c;
  });
  origCap = JSON.parse(JSON.stringify(capacity));
  for (const c of Object.values(capacity)) { delete c.raw; delete c.unread; delete c.teamRaw; delete c.etag; }
  // The Work Map's team settings (its Settings tab): the UAT swim lane, so planning can draft UAT testing tasks
  let settings = null;
  try { const m = await extData(); const doc = m && await m.getDocument('report-settings', ctx.projectId); settings = doc && doc.settings || null; } catch (e) {}
  // Meeting settings for this team (planning poker, confidence vote, step timers), saved per team
  let planning = null;
  try { const m = await extData(); const doc = m && await m.getDocument('planning-settings', ctx.teamId); planning = doc && doc.settings || null; } catch (e) {}
  D = {real: true, settings, planning, org: ctx.org, project: ctx.project, teamId: ctx.teamId, team: ctx.teamName, sprints, items, graph: {edges},
    people: members.map(m => ({name: m.name})), capacity, capacityWarnings: capWarnings};
  step(`${items.length.toLocaleString()} work items, ${sprints.length} sprints, ${members.length} team members - ${calls} calls`);
  return D;
}

// ---------------------------------------------------------------- write
const identity = name => { if (!name) return ''; const m = members.find(x => x.name === name); if (m) return m.uniqueName || m.name;
  const it = [...byId.values()].find(x => x.assignee === name && x.assigneeUnique); return it ? it.assigneeUnique : name; };
const iterPath = sp => sp >= 0 ? sprints[sp].path : ctx.project;

// A person's hours per day spread over their activities: the first activity takes the difference, the others keep
// theirs. A total below what the others keep can't be saved as reviewed, so it's refused, not silently changed.
function splitHours(raw, hpd) {
  const acts = (raw.activities || []).map(a => ({name: a.name || '', capacityPerDay: +a.capacityPerDay || 0}));
  if (!acts.length) return {acts: [{name: '', capacityPerDay: hpd}]};
  const rest = acts.slice(1).reduce((a, x) => a + x.capacityPerDay, 0);
  if (hpd < rest) return {acts, invalid: `${hpd} h/day is less than the ${rest} h/day kept for ${acts.slice(1).map(a => a.name || 'other activities').join(', ')}. ` +
    `Set at least ${rest}, or change the activities on Azure DevOps' Capacity page.`};
  acts[0].capacityPerDay = hpd - rest;
  return {acts};
}
// What differs between the plan's capacity and what Azure DevOps has
function capacityChanges(C) {
  const out = [];
  for (const [k, c] of Object.entries(C || {})) {
    const i = +k, o = origCap[i]; if (!o || !c || o.unread) continue;
    const days = dayList(sprints[i].start, sprints[i].finish);
    const full = (map, who) => days.filter(d => ((who ? (map[who] || {}) : map)[d]) === 'full').join(',');
    const part = (map, who) => JSON.stringify(Object.entries(who ? (map[who] || {}) : map).filter(([d, v]) => v !== 'full' && days.includes(d)).sort());
    for (const who of Object.keys(o.raw || {})) {
      const hpd = c.hpd[who] == null ? o.hpd[who] : c.hpd[who];
      if (hpd !== o.hpd[who] || full(c.off, who) !== full(o.off, who)) {
        const sp = splitHours(o.raw[who], hpd);
        out.push({sp: i, kind: 'member', who, from: o.hpd[who], to: hpd, invalid: sp.invalid || '',
          split: sp.acts.length > 1 ? sp.acts.map(a => `${a.name || 'no activity'} ${a.capacityPerDay}`).join(', ') : ''});
      }
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
  // 2. New tasks, linked to their story. When an earlier create's outcome was unknown (connection dropped, 503), the
  //    draft carries uncertainAt. Only those drafts are looked up first: an exact match (same story, title, owner,
  //    hours and sprint, made by you since that attempt) counts as made; anything close but different stays
  //    unresolved (res.ambiguous) until you choose: use that task, create a separate one (createAnyway), or drop the draft.
  res.notes = []; res.uncertain = []; res.ambiguous = []; res.attemptAt = new Date().toISOString();
  const unsure = plan.tasks.filter(t => t.uncertainAt && !t.createAnyway);
  let made = new Map(), lookupFailed = '';
  if (unsure.length) {
    try { made = await tasksMadeSince([...new Set(unsure.map(t => t.parent))], new Date(Math.min(...unsure.map(t => Date.parse(t.uncertainAt))) - DAY).toISOString()); }
    catch (e) { lookupFailed = e.message; }
  }
  await pool(plan.tasks, 3, async (t, k) => {
    if (t.uncertainAt && !t.createAnyway) {
      if (lookupFailed) { res.errors.push(`"${t.title}" under #${t.parent}: an earlier attempt may have created it, and checking failed (${lookupFailed}), so it wasn't created again. Try again.`); return; }
      const near = (made.get(t.parent) || []).filter(w => w.title === normTitle(t.title) && w.created >= Date.parse(t.uncertainAt) - 10 * 60e3);
      const same = near.filter(w => w.who === (t.who || '') && w.hrs === (+t.hrs || 0) && w.iteration === iterPath(t.sp).toLowerCase());
      if (near.length === 1 && same.length === 1) { res.saved.tasks.push(k); res.notes.push(`"${t.title}" under #${t.parent} was already made by the earlier attempt (#${same[0].id}), so it wasn't created again.`); return; }
      if (near.length) { res.ambiguous.push({k, ids: near.map(w => w.id)}); return; }   // nothing created; the page asks what to do
    }
    const st = byId.get(t.parent);
    const body = [
      {op: 'add', path: '/fields/System.Title', value: t.title},
      {op: 'add', path: '/fields/System.IterationPath', value: iterPath(t.sp)},
      {op: 'add', path: '/fields/System.AreaPath', value: st ? st.area : ctx.project},
      {op: 'add', path: '/fields/Microsoft.VSTS.Scheduling.RemainingWork', value: t.hrs},
      {op: 'add', path: '/relations/-', value: {rel: 'System.LinkTypes.Hierarchy-Reverse', url: `${ctx.baseUrl}/_apis/wit/workItems/${t.parent}`}}];
    if (t.who) body.push({op: 'add', path: '/fields/System.AssignedTo', value: identity(t.who)});
    try {
      const made = await api(`${ctx.projUrl}/_apis/wit/workitems/$Task`, {method: 'POST', patch: true, body});
      if (!made || !made.id) throw Object.assign(new Error("Azure DevOps didn't say which task it created"), {uncertain: true});
      res.saved.tasks.push(k);
    }
    catch (e) {
      if (e.uncertain) { res.uncertain.push(k); res.errors.push(`New task "${t.title}": the connection dropped, or Azure DevOps' answer couldn't be read, so it may or may not have been created. Saving again checks for it first, so it won't be made twice.`); }
      else res.errors.push(`New task "${t.title}": ${e.message}`);
    }
  });
  // 3. Capacity: per person (hours per day and whole days off), team days off, partial days off
  const changes = capacityChanges(plan.capacity), store = changes.some(x => x.kind === 'partial') ? await extData() : null;
  let capOk = true;
  const partialDone = new Set();
  const conflict = () => Object.assign(new Error('changed in Azure DevOps since you opened the plan. Reload to see the new values, then make your change again.'), {conflict: true});
  const norm = r => JSON.stringify({a: (r.activities || []).map(a => [a.name || '', +a.capacityPerDay || 0]), d: dayRanges(r.daysOff)});
  for (const ch of changes) {
    const s = sprints[ch.sp], c = plan.capacity[ch.sp], o = origCap[ch.sp], days = dayList(s.start, s.finish);
    const ranges = map => days.filter(d => map[d] === 'full').map(d => ({start: d + 'T00:00:00Z', end: d + 'T00:00:00Z'}));
    try {
      if (ch.kind === 'member') {
        const raw = o.raw[ch.who], hpd = c.hpd[ch.who] == null ? o.hpd[ch.who] : c.hpd[ch.who];
        const {acts, invalid} = splitHours(raw, hpd);
        if (invalid) throw new Error(invalid);
        const now = await api(`${teamUrl()}/_apis/work/teamsettings/iterations/${s.id}/capacities/${raw.id}`).catch(e => { if (e.status === 404) return {}; throw e; });
        if (norm(now) !== norm(raw)) throw conflict();
        await api(`${teamUrl()}/_apis/work/teamsettings/iterations/${s.id}/capacities/${raw.id}`, {method: 'PATCH', body: {activities: acts, daysOff: ranges(c.off[ch.who] || {})}});
      }
      else if (ch.kind === 'team') {
        const now = await api(`${teamUrl()}/_apis/work/teamsettings/iterations/${s.id}/teamdaysoff`);
        if (JSON.stringify(dayRanges(now.daysOff)) !== JSON.stringify(dayRanges(o.teamRaw))) throw conflict();
        await api(`${teamUrl()}/_apis/work/teamsettings/iterations/${s.id}/teamdaysoff`, {method: 'PATCH', body: {daysOff: ranges(c.team)}});
      }
      else if (ch.kind === 'partial') {
        if (partialDone.has(ch.sp)) continue;   // one document per sprint holds everyone's partial days
        partialDone.add(ch.sp);
        if (!store) throw new Error('extension storage is not available');
        const keep = map => Object.fromEntries(Object.entries(map || {}).filter(([d, v]) => v !== 'full' && days.includes(d)));
        const doc = {id: `${ctx.teamId}.${s.id}`, off: Object.fromEntries(Object.keys(o.raw).map(w => [w, keep(c.off[w])]).filter(([, m]) => Object.keys(m).length)), team: keep(c.team)};
        // the version read with the plan: if someone saved in between, this fails instead of replacing their days
        try { const out = o.etag == null ? await store.createDocument(PARTIAL, doc) : await store.setDocument(PARTIAL, Object.assign(doc, {__etag: o.etag})); o.etag = out && out.__etag; }
        catch (e) { throw /etag|conflict|exist|precondition/i.test(e.message || '') ? conflict() : e; }
      }
    }
    catch (e) { capOk = false; res.errors.push(`Capacity for ${ch.kind === 'partial' ? 'partial days off' : ch.who || 'the team'} in ${s.name}: ${
      e.status === 401 || e.status === 403 ? 'you don\'t have permission to change this team\'s capacity. A team or project admin can make the change or give you access.' : e.message}`); }
  }
  res.saved.capacity = capOk && changes.length > 0;
  return res;
}
const spOf = it => { let p = (it.iteration || '').toLowerCase();
  for (;;) { const i = sprints.findIndex(s => s.path.toLowerCase() === p); if (i >= 0) return i; const k = p.lastIndexOf('\\'); if (k < 0) return -1; p = p.slice(0, k); } };

async function savePlanning(p) {
  const m = await extData(); if (!m) throw new Error('Meeting settings cannot be saved here.');
  let cur = null; try { cur = await m.getDocument('planning-settings', ctx.teamId); } catch (e) {}
  const doc = {id: ctx.teamId, settings: p};
  if (cur) await m.setDocument('planning-settings', Object.assign(doc, {__etag: cur.__etag})); else await m.createDocument('planning-settings', doc);
}
async function openWorkItem(id) {
  try { (await SDK.getService('ms.vss-work-web.work-item-form-navigation-service')).openWorkItem(id, false); }
  catch (e) { window.open(`${ctx.projUrl}/_workitems/edit/${id}`, '_blank', 'noopener'); }
}

// ---------------------------------------------------------------- start
(async () => {
  try {
    const data = await load();
    window.PLANNING_API = {save, capacityChanges, openWorkItem, savePlanning, team: ctx.teamName};
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
