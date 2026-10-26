<div align="center">

# ADO Work Map for Azure DevOps

**An Azure DevOps extension: your whole project at a glance, and sprint planning as a team, right inside Boards.**

[![License: MIT](https://img.shields.io/badge/license-MIT-yellow.svg)](LICENSE)
[![Azure DevOps](https://img.shields.io/badge/Azure%20DevOps-extension-0078D7?logo=azuredevops&logoColor=white)](#install)
[![Live demo](https://img.shields.io/badge/live-demo-0078D4)](https://dascondor.github.io/ado-work-map-extension/)

### [&#9654; Try the live demo](https://dascondor.github.io/ado-work-map-extension/) &nbsp;&middot;&nbsp; [Sprint planning demo](https://dascondor.github.io/ado-work-map-extension/sprint-planning.html)

<img src="docs/images/delivery-map.png" alt="Work Map hub: epics on the left, the selected epic's features and stories with progress bars on the right" width="900">

<sub>Split from <a href="https://github.com/DasCondor/ado-work-map">ado-work-map</a> (the PowerShell script and VS Code extension), keeping its history. This repo is the Azure DevOps extension only. The live demo uses sample data, not a real project.</sub>

</div>

---

## What's supported

| | PowerShell script + HTML report | VS Code extension | Azure DevOps extension |
|---|---|---|---|
| Work Map report: Needs attention, delivery map, sprints, changes, maps, spider web | Supported | Supported | Supported |
| Access | Read-only (PAT or `az login`) | Read-only (PAT in VS Code secret storage) | Your own sign-in; writes only from Sprint planning's **Save plan** |
| Connection check | `-Check` | **Check Connection** command | Not needed (uses your sign-in) |
| Sprint planning | &mdash; | &mdash; | Preview: **Save plan** is off until you turn it on (not yet validated against a live organization); votes are entered on one shared screen |
| Live demo | Sample data only | | |

## The hubs

### Work Map

Epics, features, stories and tasks, every sprint, what changed, and how the work connects to your code.

- **Needs attention** &mdash; what to look at first: unassigned, blocked, stale and stranded work, and missing estimates, acceptance criteria or parents, each with the evidence and a link. Checks can be turned off.
- **Delivery map** &mdash; epic &rarr; task with accomplished / in progress / not started roll-ups and progress over time.
- **Sprints** &mdash; every sprint on a timeline, sprint detail, velocity and a sprint map.
- **Changes** &mdash; what was created, completed, updated or moved in any time frame, and a change log between visits.
- **Maps** &mdash; treemap, repo matrix and a commit heatmap (everyone or by person, any sprint), each narrowable to one sprint.
- **Spider web** &mdash; work items and their links, with the PRs, commits, branches, builds and repos attached.

<table>
<tr>
<td width="50%"><img src="docs/images/spider-web.png" alt="Spider web of work items, pull requests, branches, commits and repos"><br><b>Spider web</b></td>
<td width="50%"><img src="docs/images/commit-heatmap-sprint.png" alt="Commit heatmap for one sprint, by person"><br><b>Commit heatmap</b> by person, for a sprint</td>
</tr>
</table>

### Sprint planning

Sprint planning run as a guided team meeting on your real sprints and work items: capacity check-in (hours per day, full / half / partial days off, team holidays, 1&ndash;5 week sprints), carry over, planning poker with the full story in a work item form, people lanes or swimlanes with assigned work against capacity, quick **Validation** and **Assisting team member** tasks, a sprint calendar with a capacity burn-up, and a confidence vote. Votes are entered on one shared screen (the facilitator's), not synced between computers.

<img src="docs/images/sprint-planning.png" alt="Sprint planning: capacity check-in with time off per day for a 4-week sprint" width="900">

It reads the team's capacity and days off from Azure DevOps and **Save plan** lists every change and then writes the plan back (sprint, owner and points of stories, new tasks, capacity and days off). It never overwrites a story or a person's capacity someone else changed meanwhile, and keeps what didn't save so you can try again. Partial days off are kept by this extension only: Azure DevOps' own Capacity page shows whole days. The [live demo](https://dascondor.github.io/ado-work-map-extension/sprint-planning.html) runs the same page on sample data.

## Install

The extension is published privately on the Visual Studio Marketplace and shared with organizations on request. An organization admin installs it from **Organization settings > Extensions > Shared**, and it appears as **Boards > Work Map** in every project.

To publish it under your own publisher: change `publisher` in `azure-devops-extension/vss-extension.json`, build it (below), and upload the `.vsix` at [marketplace.visualstudio.com/manage](https://marketplace.visualstudio.com/manage).

**Permissions:** Work items (read & write), Code, Project and team, Analytics (read). Only **Save plan** in Sprint planning writes &mdash; stories' sprint, owner and points, new tasks, and team capacity and days off; the Work Map only reads. It reads PR metadata and commit dates and authors &mdash; never file contents or diffs &mdash; and there's no server behind it: data stays in Azure DevOps and the user's browser.

Azure DevOps Services only (not Azure DevOps Server).

## Build

| What | Command | Needs |
|---|---|---|
| Extension `.vsix` | `powershell -ExecutionPolicy Bypass -File azure-devops-extension\build.ps1` | [tfx-cli](https://www.npmjs.com/package/tfx-cli) (`npm install -g tfx-cli`) |
| Live demo (`docs/`) | `powershell -ExecutionPolicy Bypass -File demo-site\build.ps1` | Windows PowerShell 5.1 |

## What's where

| Folder | |
|---|---|
| `azure-devops-extension/` | The extension: manifest, hub code (`src/hub.js`), bundled Azure DevOps SDK (MIT), Marketplace overview and build |
| `sprint-planning/` | The Sprint planning hub (preview) and its build |
| `demo-site/` | The live demo frame and the build for `docs/` |
| `docs/` | The GitHub Pages live demo (built files) and README images |
| `report/` | The shared report engine (`ado_work_map.ps1`) the hub and demo are built from &mdash; see [report/README.md](report/README.md) |

## Security and privacy

- Reads with the signed-in person's own access, and writes only when someone clicks **Save plan** &mdash; after showing what will change, and never over a story someone else changed meanwhile.
- Work item text (descriptions, acceptance criteria) is cleaned before it's shown: only plain formatting and `https` links are kept.
- No server, no telemetry, no outside scripts: the Azure DevOps SDK is bundled, and the live demo pages run under a strict content security policy that blocks loading or sending anything.
- Not affiliated with Microsoft.

## Latest updates

**1.5.1 (preview)**: the sprint names stay frozen at the top of the sprint map and sprint detail while you scroll, and the Needs attention **Checks** menu fits on screen. It builds on **1.5.0 (preview)**: a **Needs attention** tab in the Work Map, clearer labels, and safer Sprint planning saves. In this preview **Save plan** is off until you turn it on beside the button: it's not yet validated against a live Azure DevOps organization, so use a disposable or non-critical project.

Full notes for this release and every earlier one: **[UPDATES.md](UPDATES.md)**.

## License

[MIT](LICENSE)
