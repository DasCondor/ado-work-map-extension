# Shipping an update (for BAs)

Every update is the same five steps. Nothing on the Azure DevOps side needs re-installing: organizations that already have the extension pick the new version up automatically within a few minutes of it reaching the Marketplace.

## 1. Bump the version

Open `azure-devops-extension/vss-extension.json` and raise `"version"` (for example `1.4.3` -> `1.4.4`). The Marketplace refuses a version it has seen before, so every upload needs a new number: last digit for small fixes, middle digit for new features.

## 2. Write it up

Add a short entry at the top of **Latest updates** in `README.md`, newest first. If a screen changed, retake its screenshot in `docs/images/`.

## 3. Build

In PowerShell, from the repo folder:

```powershell
powershell -ExecutionPolicy Bypass -File azure-devops-extension\build.ps1
```

This needs [Node.js](https://nodejs.org) with `npm install -g tfx-cli` once. It writes `azure-devops-extension\DasCondor.ado-work-map-boards-<version>.vsix`.

To refresh the live demo (GitHub Pages) at the same time:

```powershell
powershell -ExecutionPolicy Bypass -File demo-site\build.ps1
```

## 4. Commit, push, release

Commit everything except the `.vsix`, push to `main`, then create a GitHub release tagged `v<version>` and attach the `.vsix` to it. GitHub Pages rebuilds the live demo from `docs/` on its own.

## 5. Upload to the Marketplace

1. Sign in at [marketplace.visualstudio.com/manage](https://marketplace.visualstudio.com/manage) with the publisher account.
2. On **ADO Work Map**, choose **... > Update** and pick the new `.vsix`.
3. Wait for validation (a few minutes). The version shown on the listing changes when it's through.

Organizations the extension is already shared with get the update automatically. A **new** organization still needs the two one-time steps: share it from the same **...** menu (**Share/Unshare**, organization name), then an admin there installs it from **Organization settings > Extensions > Shared**.

## If something goes wrong

- **"Version already exists"** - go back to step 1 and pick a higher number; rebuild.
- **The hub shows old data or wording** - press F5 in Azure DevOps; the hub caches in the browser. **Work Map > Settings > Clear saved data** wipes its cache for that project.
- **Nothing changed after the upload** - check the listing's version on the Marketplace page. If it still shows the old one, validation failed; the publisher portal shows the reason.
