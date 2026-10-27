// Test stand-in for Azure DevOps REST: one team, three sprints, a few stories and tasks. Records every call
// in top.FAKE_CALLS. Flags on the test page (top.F) switch on failures: see test.html.
(function () {
  const top = window.top, F = top.F || {};
  top.FAKE_CALLS = top.FAKE_CALLS || [];
  // the data the hub hands to the planning page, for the test to read
  let rp; Object.defineProperty(window, 'runPlanning', {configurable: true, get: () => rp,
    set: f => { rp = d => { top.TEST_D = JSON.parse(JSON.stringify(d)); return f(d); }; }});
  const DAY = 864e5, iso = t => new Date(t).toISOString().slice(0, 10) + 'T00:00:00Z';
  const now = new Date(); now.setUTCHours(0, 0, 0, 0);
  const mon = now.getTime() - ((now.getUTCDay() + 6) % 7) * DAY;           // this week's Monday
  const S = [
    {id: 'it1', name: 'Sprint 1', start: mon - 14 * DAY, tf: 'past'},
    {id: 'it2', name: 'Sprint 2', start: mon, tf: 'current'},
    {id: 'it3', name: 'Sprint 3', start: mon + 14 * DAY, tf: 'future'}
  ].map(s => ({id: s.id, name: s.name, path: 'Fabrikam\\' + s.name, attributes: {startDate: iso(s.start), finishDate: iso(s.start + 11 * DAY), timeFrame: s.tf}}));
  const s3 = S[2].attributes.startDate.slice(0, 10), s3d = k => iso(Date.parse(s3 + 'T00:00:00Z') + k * DAY);
  const WI = id => `https://dev.azure.com/contoso/_apis/wit/workItems/${id}`;
  const ppl = {ana: {displayName: 'Ana Ruiz', uniqueName: 'ana@contoso.com', id: 'm1'}, ben: {displayName: 'Ben Ode', uniqueName: 'ben@contoso.com', id: 'm2'}, chen: {displayName: 'Chen Li', uniqueName: 'chen@contoso.com', id: 'm3'}};
  const item = (id, type, title, state, iter, who, extra, rels) => ({id, rev: 7, fields: Object.assign({'System.WorkItemType': type, 'System.Title': title, 'System.State': state,
    'System.IterationPath': iter, 'System.AreaPath': 'Fabrikam\\Web', 'System.AssignedTo': who ? ppl[who] : undefined}, extra || {}), relations: rels || []});
  const items = [
    item(100, 'Feature', 'Checkout', 'Active', 'Fabrikam', 'ana'),
    item(101, 'User Story', 'Pay with saved card', 'Active', 'Fabrikam\\Sprint 2', 'ana', {'Microsoft.VSTS.Scheduling.StoryPoints': 3}, [{rel: 'System.LinkTypes.Hierarchy-Reverse', url: WI(100)}]),
    item(102, 'User Story', 'Refund to original card', 'New', 'Fabrikam', 'ben', F.lane ? {'System.BoardLane': 'BA Review'} : {}, [{rel: 'System.LinkTypes.Hierarchy-Reverse', url: WI(100)}]),
    item(103, 'User Story', 'Receipt email', 'New', 'Fabrikam', 'chen', {'Microsoft.VSTS.Scheduling.StoryPoints': 5}, [{rel: 'System.LinkTypes.Hierarchy-Reverse', url: WI(100)}]),
    item(111, 'Task', 'Build API', 'Active', 'Fabrikam\\Sprint 2', 'ana', {'Microsoft.VSTS.Scheduling.RemainingWork': 6}, [{rel: 'System.LinkTypes.Hierarchy-Reverse', url: WI(101)}])
  ];
  const caps = {
    it2: {teamMembers: [{teamMember: ppl.ana, activities: [{name: 'Development', capacityPerDay: 6}], daysOff: []}, {teamMember: ppl.ben, activities: [{name: 'Development', capacityPerDay: 4}], daysOff: []}]},
    it3: {teamMembers: [{teamMember: ppl.ana, activities: [{name: 'Development', capacityPerDay: 6}], daysOff: [{start: s3d(4), end: s3d(4)}]},
                        {teamMember: ppl.ben, activities: [{name: 'Development', capacityPerDay: 3}, {name: 'Testing', capacityPerDay: 2}], daysOff: []}]}
  };
  const teamOff = {it2: {daysOff: []}, it3: {daysOff: [{start: s3d(7), end: s3d(7)}]}};
  const json = (o, status) => Promise.resolve(new Response(JSON.stringify(o), {status: status || 200, headers: {'Content-Type': 'application/json'}}));
  let flaky = F.flakyGet || 0;
  window.fetch = (url, opt) => {
    opt = opt || {};
    const u = new URL(url), p = decodeURIComponent(u.pathname), method = opt.method || 'GET', body = opt.body ? JSON.parse(opt.body) : null;
    top.FAKE_CALLS.push({method, path: p, body});
    if ((opt.headers || {}).Authorization !== 'Bearer fake-token') return json({message: 'no token'}, 401);
    if (method === 'GET' && flaky > 0 && p.endsWith('/teamsettings/iterations')) { flaky--; return Promise.reject(new TypeError('Failed to fetch')); }
    if (method === 'GET' && p.endsWith('/teamsettings/iterations')) return json({value: S});
    if (p.endsWith('/teamsettings/teamfieldvalues')) return json({field: {referenceName: 'System.AreaPath'}, values: [{value: 'Fabrikam\\Web', includeChildren: true}]});
    if (/\/teams\/t1\/members$/.test(p)) return json({value: [{identity: ppl.ana}, {identity: ppl.ben}, {identity: ppl.chen}]});
    if (p.endsWith('/_apis/wit/wiql')) return /WorkItemLinks/.test(body.query) ? json({workItemRelations: F.recent || []}) : json({workItems: items.map(i => ({id: i.id}))});
    if (p.endsWith('/_apis/wit/workitemsbatch')) return json({value: body.ids.map(id => items.find(i => i.id === id) || (F.made || []).find(i => i.id === id)).filter(Boolean)});
    if (/workitemtypes\/.+\/states$/.test(p)) return json({value: [{name: 'New', category: 'Proposed'}, {name: 'Active', category: 'InProgress'}, {name: 'Closed', category: 'Completed'}]});
    let m;
    if ((m = /iterations\/(it\d)\/capacities$/.exec(p))) return F.capFail === m[1] ? json({message: 'server error'}, 500) : json(caps[m[1]] || {teamMembers: []});
    if ((m = /iterations\/(it\d)\/teamdaysoff$/.exec(p))) return method !== 'GET' ? json({}) : F.offFail === m[1] ? json({message: 'server error'}, 500) : json(teamOff[m[1]] || {daysOff: []});
    if (method === 'GET' && (m = /iterations\/(it\d)\/capacities\/(m\d)$/.exec(p))) {
      const r = ((caps[m[1]] || {}).teamMembers || []).find(x => x.teamMember.id === m[2]);
      if (!r) return json({message: 'none'}, 404);
      return json(F.capChanged ? Object.assign({}, r, {activities: [{name: 'Development', capacityPerDay: 1}]}) : r);
    }
    if (method === 'PATCH' && /iterations\/it\d\/capacities\/m\d$/.test(p)) return F.cap403 ? json({message: 'Access denied'}, 403) : json({});
    if (method === 'PATCH' && (m = /\/_apis\/wit\/workitems\/(\d+)$/.exec(p))) {
      if (+m[1] === 103 && F.fail103) return json({message: 'The update failed because the test operation on /rev failed: work item 103 has changed.'}, 400);
      return json({id: +m[1], rev: 8});
    }
    if (method === 'POST' && p.endsWith('/_apis/wit/workitems/$Task')) return F.taskDrop ? Promise.reject(new TypeError('Failed to fetch')) : F.task503 ? json({message: 'Service Unavailable'}, 503)
      : F.badJson ? Promise.resolve(new Response('<html>not json', {status: 200, headers: {'Content-Type': 'application/json'}})) : json({id: 900, rev: 1});
    return json({message: 'not faked: ' + method + ' ' + p}, 404);
  };
})();
