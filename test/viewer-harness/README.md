# Report-viewer harness

Drives `report/report.html` in real headless Chrome with the extension APIs
stubbed, so the report viewer can be tested without loading the extension.

## Why it exists

Chrome 137+ restricts `--load-extension`, and the extension's own
`chrome.debugger` calls conflict with any external CDP client (Playwright,
`chrome-remote-interface`) attached to the same target. So the usual
"load the extension and drive it" approach does not work for this project.

The report viewer, though, is just DOM rendering driven by a report object
and two `chrome.*` calls. Stub those and it runs from `file://`.

**Scope:** the viewer only. The capture path (`captureFullPageScreenshot`,
`captureElementShotsInSession`) genuinely needs `chrome.debugger` against a
live page and must be checked by hand — load the extension unpacked, tick
**Screenshots** in the popup, and run a scan.

## Files

| File | Role |
| --- | --- |
| `makepng.js` | Generates `shots.js`: real PNGs (480×320 page shots, 400×300 element crops) as data URLs. Real bytes, so image decoding is actually exercised and `naturalWidth` can be asserted. |
| `stub.js` | Defines `window.chrome` (`runtime.sendMessage`, `storage.local.get`) and a synthetic report matching `buildReport()`'s real return shape — including `pages` (carries `screenshot`) being distinct from `pagesRows` (does not). |
| `assert.js` | Renders PASS/FAIL lines into `<pre id="harness-results">` for `--dump-dom` to read. |
| `focus.js` | Visual mode only (`&visual=1`): strips unrelated sections so a screenshot frames the gallery and Violations table. |

`stub.js` deliberately routes three cases differently: one shot resolvable
only from `chrome.storage.local`, one only via the `GET_SCREENSHOT` message
fallback, and one from neither — that last must degrade to a visible
"unavailable" state rather than throwing.

## Running

Copy the harness next to the real viewer files, then point Chrome at it:

```sh
H=$(mktemp -d)
cp report/report.html report/report.css report/report.js test/viewer-harness/*.js "$H"/
cd "$H" && node makepng.js

# Inject the stubs before report.js and the assertions after it.
python3 - <<'PY'
import pathlib
p = pathlib.Path("report.html"); h = p.read_text()
h = h.replace('<script src="report.js"></script>',
              '<script src="shots.js"></script>\n'
              '    <script src="stub.js"></script>\n'
              '    <script src="report.js"></script>\n'
              '    <script src="assert.js"></script>\n'
              '    <script src="focus.js"></script>')
p.write_text(h)
PY

CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

# Assertions
"$CHROME" --headless=new --disable-gpu --allow-file-access-from-files \
  --virtual-time-budget=15000 --dump-dom "file://$H/report.html?id=r-test" \
  | grep -A100 HARNESS-START

# Screenshot
"$CHROME" --headless=new --disable-gpu --allow-file-access-from-files \
  --virtual-time-budget=20000 --window-size=1500,1150 \
  --screenshot="$H/shot.png" "file://$H/report.html?id=r-test&visual=1"
```

`--virtual-time-budget` matters: the viewer renders from an async IIFE after
`load`, and the lazy loader does async storage work after that. Without it
`--dump-dom` captures an empty page.

Do not run the assertion pass with `&visual=1` — `focus.js` removes the
results block.

## Coverage

23 assertions: gallery presence and reveal, card count (a page without a
screenshot must not produce a card), Screenshot column header, `td`/`th`/
`colspan` consistency, em-dash placeholder for issues with no shot, all three
resolution paths, storage-before-message ordering, decoded image dimensions,
and that the status pills and tiles still render.
