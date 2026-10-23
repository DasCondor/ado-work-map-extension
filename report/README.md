# Report engine

`ado_work_map.ps1` is the report engine shared with [ado-work-map](https://github.com/DasCondor/ado-work-map), where it is also a
standalone PowerShell tool. In this repo it is a build input only:

- `azure-devops-extension/build.ps1` takes the report template out of it, so the Work Map hub shows exactly the same report.
- `demo-site/build.ps1` and `sprint-planning/build.ps1` run it with `-Demo` to make the sample data for the live demo.

Changes to the report itself are best made in ado-work-map and copied here.
