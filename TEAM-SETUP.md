# Team setup — install and stay updated

## One-time setup

1. Get collaborator access to the private repo, then clone to a **local**
   folder — never inside OneDrive/Drive/Dropbox (cloud sync corrupts git
   state and can dehydrate files Chrome needs mid-session):
   ```bash
   git clone https://github.com/EnableUser-Suryanshu/EnableUser_Accessibility_Widget.git
   cd EnableUser_Accessibility_Widget
   ```
2. Build the vendored engine (gitignored on purpose; the lockfile pins the
   exact axe-core build so everyone gets byte-identical engines):
   ```bash
   npm ci && node build.js
   ```
3. Load it: `chrome://extensions` → toggle **Developer mode** → **Load
   unpacked** → select the cloned folder → pin the icon.
4. Open DevTools (F12) on any page → **EnableUser** tab. That panel is the
   full surface: page scan, workflow recorder, site crawl, guided tests,
   settings.

## Getting updates

```bash
git pull
```
then `chrome://extensions` → **↻ Reload** on the EnableUser card.

**Both steps, every time.** Chrome caches the extension's service worker per
profile — after a pull the OLD code keeps running until you press Reload.
If behaviour ever looks stale or wrong, Reload first before reporting a bug.

Re-run `npm ci && node build.js` only when told an engine bump landed
(package-lock.json changed).

## Which branch

Track whatever branch the team lead announces as current
(`main` after PR #1 merges; `workflow-mode` until then):
```bash
git checkout <branch> && git pull
```

## Reporting problems

Include: the commit you're on (`git log --oneline -1`), the extension card's
Errors output (chrome://extensions → Errors), and what page/action triggered
it. "It doesn't work" without a commit hash is unanswerable.
