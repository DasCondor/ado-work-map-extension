# ADO Work Map

A **Work Map** hub in **Boards** that shows a whole project at a glance - what's accomplished, what's left, what's in the current sprint, and how work items, pull requests, commits, branches and repos connect.

It's the same interactive report as the free [ADO Work Map PowerShell script](https://github.com/DasCondor/ado-work-map), built into Azure DevOps: no PAT, no script, no setup.

![Delivery map](images/delivery-map.png)

## What's in it

- **Delivery map** - Epic > Feature > Story > Task with accomplished / in progress / not started roll-ups, an epic list for big projects, collapse to any level, and progress over time.
- **Sprints** - every sprint on a timeline, the detail of any sprint, velocity, and a features x sprints map.
- **Changes** - what was created, completed, updated or moved in any time frame, plus a change log recorded between your visits.
- **Maps** - a treemap of epics and features by % done, a repo matrix, and a commit heatmap for everyone or by person, with details on hover. Narrow every map to one sprint.
- **Spider web** - work items and their links (parent/child, related, dependencies) plus the PRs, commits, branches, builds and repos attached to them. Starts on the current sprint; overview and focus modes keep big projects responsive.

Filters (search, epic, person, area, tag), light / dark theme, and links straight to every work item.

![Spider web](images/spider-web.png)

## How it works

- Open **Boards > Work Map** in any project.
- It reads with **your own access**: you only see what you can already see in Azure DevOps.
- The first visit pulls everything; after that only what changed since your last visit is pulled, so it opens quickly.
- Data is kept **in your browser** (IndexedDB) for this project. Nothing is sent anywhere except to Azure DevOps itself - there's no server behind this extension.
- **Settings** in the hub: team (for sprints), area path, work item types, epic ids, closed-within days, commit heatmap days.
- **Pull history** fills the progress-over-time chart from Azure DevOps Analytics.

![Sprints](images/sprints.png)

## Sprint planning

A second hub, **Boards > Sprint planning**, runs sprint planning as a team meeting on your real sprints and work items:

- **Capacity check-in** - each person's hours per day and days off from the team's capacity, plus half days or a few hours off, and team days off.
- **Carry over** last sprint's unfinished work, **planning poker** with the story's description and acceptance criteria, and **people lanes or swimlanes** with assigned work against capacity.
- Quick **Validation** and **Assisting team member** tasks, a sprint calendar with a capacity burn-up, and a confidence vote.
- **Save plan** writes it all back: stories' sprint, owner and points, the new tasks, and capacity and days off. A story someone else changed meanwhile is never overwritten.

## Permissions

| Scope | Used for |
|---|---|
| Work items (read) | Work items, states, sprints |
| Code (read) | Repos, pull request titles / status / branches, commit dates and authors - never file contents or diffs |
| Project and team (read) | The team list in Settings |
| Analytics (read) | Only when you click **Pull history** |
| Work items (read & write) | Only when someone clicks **Save plan** in Sprint planning: sprint, owner and points of stories, new tasks |

Team capacity and days off are saved through the team settings (the same as the Capacity page). Partial days off, which Azure DevOps can't store, are kept in this extension's data storage for the team. The Work Map never writes anything.

![Commit heatmap](images/commit-heatmap.png)

## Source

MIT licensed: [github.com/DasCondor/ado-work-map-extension](https://github.com/DasCondor/ado-work-map-extension). Issues and ideas welcome there.
