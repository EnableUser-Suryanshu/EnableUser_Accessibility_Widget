// v0.4.5 — EnableUser WCAG 2.1 AA Manual Test Checklist (v1.2, 129 cases).
// Source: the team's manually-authored checklist covering the success
// criteria automated scanners are weak at (hover/focus states, keyboard
// traps, modal traps, form errors, moving content, visited-link contrast).
// Embedded so every crawl report ships a "Manual Checklist" sheet scoped by
// what the crawler actually found on each page.

export const MANUAL_CHECKLIST_VERSION = "1.2";

export const MANUAL_TESTS = [
 {
  "id": "K-01",
  "pass": "1 Keyboard-only",
  "sc": "2.4.1",
  "level": "A",
  "verify": "Skip link is the first focusable element and works",
  "how": "Load the page. Press Tab exactly once. Then press Enter.",
  "passCriterion": "A visible 'Skip to main content' link appears on the first Tab, and activating it moves focus into <main>.",
  "trap": "No skip link at all; a skip link hidden with display:none (removed from tab order); target has no tabindex='-1' so the viewport scrolls but focus stays in the nav."
 },
 {
  "id": "K-02",
  "pass": "1 Keyboard-only",
  "sc": "2.4.7",
  "level": "AA",
  "verify": "Every focus stop has a visible indicator",
  "how": "Tab through the entire page from top to bottom. Do not skip anything.",
  "passCriterion": "At every single stop you can tell, unambiguously, where you are.",
  "trap": "A global *:focus { outline: none } in the CSS reset with no :focus-visible replacement."
 },
 {
  "id": "K-03",
  "pass": "1 Keyboard-only",
  "sc": "2.4.7",
  "level": "AA",
  "verify": "Focus indicator is not clipped",
  "how": "Tab to controls inside cards, dropdowns, table cells and scroll containers.",
  "passCriterion": "The full ring is visible at every stop.",
  "trap": "overflow: hidden on a parent slices the ring off. Use outline-offset with room, or box-shadow."
 },
 {
  "id": "K-04",
  "pass": "1 Keyboard-only",
  "sc": "2.4.3",
  "level": "A",
  "verify": "Tab order matches the visual reading order",
  "how": "Tab through and narrate your position aloud. Watch for jumps.",
  "passCriterion": "The focus path follows the visual flow with no backtracking.",
  "trap": "A positive tabindex anywhere on the page hoists that element ahead of everything natural and corrupts the whole sequence."
 },
 {
  "id": "K-05",
  "pass": "1 Keyboard-only",
  "sc": "2.1.2",
  "level": "A",
  "verify": "No keyboard trap — forward and reverse",
  "how": "Tab front-to-back, then Shift+Tab back-to-front, all the way. Mouse stays untouched.",
  "passCriterion": "You never get stuck. Every component you can enter, you can leave.",
  "trap": "A trap forces a page reload and loses all form data."
 },
 {
  "id": "K-06",
  "pass": "1 Keyboard-only",
  "sc": "2.1.2",
  "level": "A",
  "verify": "Third-party embeds can be escaped",
  "how": "Tab INTO every embedded video player, chat widget, PDF viewer, rich-text editor and iframe. Then Tab out.",
  "passCriterion": "Keyboard exit exists and is documented if non-obvious (e.g. Esc-then-Tab for CKEditor/TinyMCE).",
  "trap": "This is where real traps live. Rich-text editors capture Tab for indentation."
 },
 {
  "id": "K-07",
  "pass": "1 Keyboard-only",
  "sc": "2.1.1",
  "level": "A",
  "verify": "Every mouse-operable control is keyboard-operable",
  "how": "Complete every task on the page with only Tab, Shift+Tab, Enter, Space, arrows and Esc.",
  "passCriterion": "Nothing requires a mouse.",
  "trap": "<div onclick> with no tabindex and no key handler. Custom dropdowns, sliders, carousels and date pickers that are mouse-only."
 },
 {
  "id": "K-08",
  "pass": "1 Keyboard-only",
  "sc": "2.1.1",
  "level": "A",
  "verify": "Composite widgets follow the APG keyboard model",
  "how": "For each menu, tab set, grid, combobox, listbox and tree: arrows move within, Tab moves out.",
  "passCriterion": "Matches the ARIA Authoring Practices pattern for that role.",
  "trap": "Hand-rolled keyboard models. Controls that respond to Enter but not Space where the role demands both."
 },
 {
  "id": "K-09",
  "pass": "1 Keyboard-only",
  "sc": "2.1.1",
  "level": "A",
  "verify": "Drag-and-drop has a keyboard path",
  "how": "Try to reorder / move / resize anything drag-driven using only the keyboard.",
  "passCriterion": "A Move-up/Move-down pair, or a select-then-place interaction, exists.",
  "trap": "Drag-only reordering in dashboards and watchlists."
 },
 {
  "id": "K-10",
  "pass": "1 Keyboard-only",
  "sc": "2.4.3",
  "level": "A",
  "verify": "Modal: opening moves focus INTO the dialog",
  "how": "Activate every modal, drawer and popover trigger by keyboard.",
  "passCriterion": "Focus lands on the dialog heading or its first control.",
  "trap": "Dialog opens visually; focus stays on the trigger behind it."
 },
 {
  "id": "K-11",
  "pass": "1 Keyboard-only",
  "sc": "2.1.2",
  "level": "A",
  "verify": "Modal: Esc closes it",
  "how": "With the modal open, press Esc.",
  "passCriterion": "The modal closes.",
  "trap": "Esc alone is not discoverable — a visible focusable Close button must ALSO exist (K-13)."
 },
 {
  "id": "K-12",
  "pass": "1 Keyboard-only",
  "sc": "2.4.3",
  "level": "A",
  "verify": "Modal: focus is contained, and restored on close",
  "how": "With the modal open, Tab repeatedly past the last control. Then close it.",
  "passCriterion": "Focus cycles inside the dialog and never reaches the page behind. On close, focus returns to the trigger that opened it.",
  "trap": "Focus restore is the most-missed step in the whole open/contain/restore contract. Note: a modal's focus trap is CORRECT — it is only a 2.1.2 violation if there is no keyboard exit."
 },
 {
  "id": "K-13",
  "pass": "1 Keyboard-only",
  "sc": "2.1.2",
  "level": "A",
  "verify": "Modal: a visible, focusable Close button exists",
  "how": "Look for it. Tab to it. Activate it.",
  "passCriterion": "Present, reachable, and has a real accessible name.",
  "trap": "Icon-only X with no accessible name; close available only via Esc."
 },
 {
  "id": "K-14",
  "pass": "1 Keyboard-only",
  "sc": "3.2.1",
  "level": "A",
  "verify": "Focus alone never changes context",
  "how": "Tab through every control, especially every <select>. Do not activate anything.",
  "passCriterion": "Nothing navigates, submits, opens a window, or moves focus elsewhere.",
  "trap": "A <select> wired to navigate on focus. Revealing a tooltip on focus is NOT a change of context and is fine."
 },
 {
  "id": "K-15",
  "pass": "1 Keyboard-only",
  "sc": "3.2.1",
  "level": "A",
  "verify": "Nothing steals focus on load",
  "how": "Load the page and press Tab once. Note where you land.",
  "passCriterion": "Focus starts at the top of the document.",
  "trap": "autofocus on a search box steals focus from a screen reader user reading the header. Acceptable only on a page whose sole purpose is that one field (login, search-only)."
 },
 {
  "id": "K-16",
  "pass": "1 Keyboard-only",
  "sc": "2.1.4",
  "level": "A",
  "verify": "Single-character shortcuts are disableable, remappable, or scoped",
  "how": "Click a non-input area of the page. Press single letters: s, j, k, /, ?, etc.",
  "passCriterion": "Nothing fires; OR a settings toggle to disable exists; OR the shortcut is scoped to a focused component.",
  "trap": "Global single-letter shortcuts break speech-input users, whose dictation emits stray characters. Guarding against input/textarea/contenteditable is necessary but NOT sufficient."
 },
 {
  "id": "K-17",
  "pass": "1 Keyboard-only",
  "sc": "2.4.3",
  "level": "A",
  "verify": "Inline-revealed content is inserted after its trigger",
  "how": "Expand an accordion, click 'Load more', open an inline panel. Then press Tab once.",
  "passCriterion": "The next Tab lands inside the newly revealed content.",
  "trap": "Content appended elsewhere in the DOM, so Tab jumps past it entirely."
 },
 {
  "id": "F-01",
  "pass": "2 Forms & errors",
  "sc": "3.3.2",
  "level": "A",
  "verify": "Every field has a persistent visible label",
  "how": "Type one character into each field and watch what happens to its label.",
  "passCriterion": "The label remains visible while typing.",
  "trap": "A PLACEHOLDER IS NOT A LABEL — and placeholder-as-label passes axe, because the placeholder supplies an accessible name. This is the single most common form defect we find."
 },
 {
  "id": "F-02",
  "pass": "2 Forms & errors",
  "sc": "1.3.1",
  "level": "A",
  "verify": "Label is programmatically associated",
  "how": "Click the label text. Then check the accessibility pane.",
  "passCriterion": "Clicking the label focuses the field, and the accessible name matches the visible label.",
  "trap": "Visual-only label sitting next to the input with no for/id."
 },
 {
  "id": "F-03",
  "pass": "2 Forms & errors",
  "sc": "3.3.2",
  "level": "A",
  "verify": "Format and constraint rules are stated BEFORE submission",
  "how": "Read the form cold, as a first-time user. Note anything you would have to guess.",
  "passCriterion": "Date format, password rules, accepted file types and character limits are visible up front, wired via aria-describedby.",
  "trap": "Rules revealed only after a failed submit."
 },
 {
  "id": "F-04",
  "pass": "2 Forms & errors",
  "sc": "3.3.2",
  "level": "A",
  "verify": "Required fields are marked in text, not just an asterisk",
  "how": "Check the markup and the label copy.",
  "passCriterion": "The native required (or aria-required='true') is present AND the word 'required' appears in the label or an associated hint.",
  "trap": "A red asterisk alone depends on a legend the user may never encounter — and is also a 1.4.1 failure."
 },
 {
  "id": "F-05",
  "pass": "2 Forms & errors",
  "sc": "1.3.1",
  "level": "A",
  "verify": "Radio and checkbox groups are grouped",
  "how": "Check that grouped controls sit inside <fieldset> with a <legend>.",
  "passCriterion": "The group name is announced with each option.",
  "trap": "Loose radios with a heading above them; the group name is lost entirely to a screen reader."
 },
 {
  "id": "F-06",
  "pass": "2 Forms & errors",
  "sc": "1.3.5",
  "level": "AA",
  "verify": "Personal-data fields carry a valid autocomplete token",
  "how": "Inspect every field that collects information ABOUT THE USER.",
  "passCriterion": "Each has a token from the 53 WCAG-recognised list: name, email, tel, street-address, postal-code, bday, cc-number, etc.",
  "trap": "Missing autocomplete entirely — the scanner only validates a token that is already there. Out of scope: 'search products', 'enter recipient's name'."
 },
 {
  "id": "F-07",
  "pass": "2 Forms & errors",
  "sc": "1.3.5",
  "level": "AA",
  "verify": "autocomplete='off' is not on personal-data fields",
  "how": "Grep the form markup.",
  "passCriterion": "No autocomplete='off' on personal-data fields.",
  "trap": "Security teams request it. Point them at autocomplete='new-password' / 'current-password', which are both valid and correct."
 },
 {
  "id": "F-08",
  "pass": "2 Forms & errors",
  "sc": "3.3.1",
  "level": "A",
  "verify": "Submit empty: every error is identified in text",
  "how": "Submit the form with all fields blank.",
  "passCriterion": "Each error is described in text and names the field it belongs to.",
  "trap": "A generic 'There was an error' with no indication of which field."
 },
 {
  "id": "F-09",
  "pass": "2 Forms & errors",
  "sc": "3.3.1",
  "level": "A",
  "verify": "Error text is programmatically associated with its field",
  "how": "Inspect the failing field in DevTools.",
  "passCriterion": "aria-invalid='true' is set AND aria-describedby points at the error message.",
  "trap": "Error text visually adjacent but not associated. A screen reader user tabbing back to the field hears nothing."
 },
 {
  "id": "F-10",
  "pass": "2 Forms & errors",
  "sc": "4.1.3",
  "level": "AA",
  "verify": "The error is announced on submit",
  "how": "Submit invalid data with NVDA running.",
  "passCriterion": "Either focus moves to an error summary (role='alert', tabindex='-1') at the top of the form, or an existing live region announces it.",
  "trap": "Errors appended to the DOM with no live region — the screen reader never learns the submit failed."
 },
 {
  "id": "F-11",
  "pass": "2 Forms & errors",
  "sc": "3.3.3",
  "level": "AA",
  "verify": "Every error says HOW TO FIX, not just what is wrong",
  "how": "Submit bad data into every field. Read each message.",
  "passCriterion": "'Enter an email address in the format name@example.com', not 'Invalid email'. 'Enter the date as DD/MM/YYYY, for example 31/03/1990', not 'Invalid date'.",
  "trap": "3.3.1 requires you to say WHAT is wrong. 3.3.3 requires you to say HOW to fix it. A message that only names the problem passes 3.3.1 and fails 3.3.3."
 },
 {
  "id": "F-12",
  "pass": "2 Forms & errors",
  "sc": "1.4.1",
  "level": "A",
  "verify": "Error is not conveyed by a red border alone",
  "how": "Submit invalid data. Apply filter: grayscale(1) in DevTools.",
  "passCriterion": "The error is still identifiable — text and/or an icon is present, not just a colour change.",
  "trap": "Red border only. Also check the required-field indicator and any 'field is valid' green tick."
 },
 {
  "id": "F-13",
  "pass": "2 Forms & errors",
  "sc": "3.3.1",
  "level": "A",
  "verify": "aria-invalid is not set on initial render",
  "how": "Load the form fresh, before touching anything. Inspect.",
  "passCriterion": "No aria-invalid='true' anywhere until validation has actually failed.",
  "trap": "Fields pre-marked invalid announce every field as 'invalid' before the user has typed a character."
 },
 {
  "id": "F-14",
  "pass": "2 Forms & errors",
  "sc": "3.2.2",
  "level": "A",
  "verify": "Changing a control's value does not change context",
  "how": "Focus every <select> and arrow through the options with the keyboard. Do not press Enter.",
  "passCriterion": "Nothing navigates or submits.",
  "trap": "The jump menu: <select onchange='location.href=this.value'>. A keyboard user arrowing through triggers navigation on the FIRST option they land on."
 },
 {
  "id": "F-15",
  "pass": "2 Forms & errors",
  "sc": "3.2.2",
  "level": "A",
  "verify": "Auto-advancing OTP inputs behave predictably",
  "how": "Type a code. Press Backspace. Paste a full code into the first field.",
  "passCriterion": "Backspace steps back to the previous field; pasting the full code fills all fields.",
  "trap": "Focus jumps that a screen reader user cannot follow; paste that only fills box one."
 },
 {
  "id": "F-16",
  "pass": "2 Forms & errors",
  "sc": "2.2.1",
  "level": "A",
  "verify": "Session timeout warns and can be extended",
  "how": "Leave the session idle until it expires. Yes, actually wait.",
  "passCriterion": "A warning appears at least 20 seconds before expiry, as a real modal dialog with an accessible extend control, allowing at least 10 extensions.",
  "trap": "Silent logout. A toast the screen reader user never hears is not a warning. Security session timeouts are NOT exempt from this criterion."
 },
 {
  "id": "F-17",
  "pass": "2 Forms & errors",
  "sc": "3.3.4",
  "level": "AA",
  "verify": "Legal / financial / data-deleting actions are reversible, checked, or confirmed",
  "how": "Walk every transactional flow to the point of no return: fund transfer, order placement, mandate creation, account modification, document deletion.",
  "passCriterion": "At least ONE of the three is present: an undo window; server-side validation with a chance to correct; or an explicit review-and-confirm step.",
  "trap": "Highest regulatory salience in the whole checklist for a SEBI/RBI-regulated client. A one-click irreversible transfer fails outright."
 },
 {
  "id": "F-18",
  "pass": "2 Forms & errors",
  "sc": "3.3.4",
  "level": "AA",
  "verify": "Confirmation dialogs name the consequence",
  "how": "Read the confirm button and the dialog body.",
  "passCriterion": "The button describes the action: 'Delete 3 invoices', not 'OK' or 'Yes'. The body states exactly what will happen and whether it can be undone.",
  "trap": "'Are you sure?' with an OK button. Also: window.confirm() is untestable, unstyleable, and blocks the browser."
 },
 {
  "id": "F-19",
  "pass": "2 Forms & errors",
  "sc": "4.1.3",
  "level": "AA",
  "verify": "Status messages are announced without focus moving",
  "how": "With NVDA running: run a search, add to cart, save a form, apply a filter.",
  "passCriterion": "Each result is announced ('12 results found', 'Saved') without focus moving.",
  "trap": "Silent success. The user has no idea the action worked."
 },
 {
  "id": "F-20",
  "pass": "2 Forms & errors",
  "sc": "4.1.3",
  "level": "AA",
  "verify": "The live region pre-exists its content",
  "how": "Inspect the DOM BEFORE triggering the status message.",
  "passCriterion": "An empty <div role='status' aria-live='polite'> is already in the DOM on page load.",
  "trap": "THE RULE THAT TRIPS EVERYONE: injecting <div role='status'>Saved</div> in one operation announces NOTHING. Screen readers only announce changes to an EXISTING region. Also: visually-hidden works, display:none does not."
 },
 {
  "id": "F-21",
  "pass": "2 Forms & errors",
  "sc": "4.1.3",
  "level": "AA",
  "verify": "Politeness level is appropriate",
  "how": "Inspect each live region.",
  "passCriterion": "role='status' (polite) for search counts, save confirmations, cart updates. role='alert' (assertive) ONLY for errors and time-sensitive warnings.",
  "trap": "Assertive everywhere interrupts the user mid-sentence. Also: progress bars should use role='progressbar' with aria-valuenow, not a live region firing on every percent."
 },
 {
  "id": "Z-01",
  "pass": "3 Zoom, reflow & spacing",
  "sc": "1.4.4",
  "level": "AA",
  "verify": "Viewport meta does not suppress zoom",
  "how": "View source. Read the viewport meta tag.",
  "passCriterion": "content='width=device-width, initial-scale=1'. No user-scalable=no. No maximum-scale.",
  "trap": "Scanner catches this one — treat as a verification step, not a discovery step."
 },
 {
  "id": "Z-02",
  "pass": "3 Zoom, reflow & spacing",
  "sc": "1.4.4",
  "level": "AA",
  "verify": "200% browser zoom loses nothing",
  "how": "Ctrl/Cmd + '+' to 200%. Read the whole page.",
  "passCriterion": "No clipping, no overlap, no loss of content or functionality.",
  "trap": "Fixed pixel heights on containers."
 },
 {
  "id": "Z-03",
  "pass": "3 Zoom, reflow & spacing",
  "sc": "1.4.4",
  "level": "AA",
  "verify": "200% TEXT-ONLY zoom loses nothing",
  "how": "Firefox: View > Zoom > Zoom Text Only, then zoom to 200%.",
  "passCriterion": "No clipping, no overlap.",
  "trap": "Harsher than full-page zoom and exposes fixed-height bugs immediately. px font sizes ignore the user's browser font-size preference entirely — size text in rem."
 },
 {
  "id": "Z-04",
  "pass": "3 Zoom, reflow & spacing",
  "sc": "1.4.10",
  "level": "AA",
  "verify": "No horizontal scroll at 320 CSS px",
  "how": "Set the viewport to exactly 320 x 256 CSS px (or 400% zoom at 1280 x 1024).",
  "passCriterion": "Content reflows to a single column. Vertical scrolling only.",
  "trap": "Fixed-width containers (width: 1200px instead of max-width). Exempt: data tables, maps, complex diagrams."
 },
 {
  "id": "Z-05",
  "pass": "3 Zoom, reflow & spacing",
  "sc": "1.4.10",
  "level": "AA",
  "verify": "Sticky headers do not eat the viewport at 400%",
  "how": "At 400% zoom, measure how much vertical space the sticky header occupies.",
  "passCriterion": "No more than ~20vh.",
  "trap": "A position:sticky header sized in px can consume 60% of the screen at 400%. Cap with max-height: 20vh or drop stickiness under a height media query."
 },
 {
  "id": "Z-06",
  "pass": "3 Zoom, reflow & spacing",
  "sc": "1.4.10",
  "level": "AA",
  "verify": "Long unbroken strings wrap",
  "how": "At 320px, find every long token: URLs, hashes, ISINs, PAN, folio numbers, UTR, transaction IDs.",
  "passCriterion": "They wrap (overflow-wrap: break-word) rather than forcing horizontal scroll.",
  "trap": "Very common on financial portals — reference numbers are long and unbroken by nature."
 },
 {
  "id": "Z-07",
  "pass": "3 Zoom, reflow & spacing",
  "sc": "1.4.10",
  "level": "AA",
  "verify": "Data tables are keyboard-scrollable",
  "how": "Tab to any horizontally-scrolling table.",
  "passCriterion": "It is wrapped in a focusable container: <div role='region' aria-label='...' tabindex='0' style='overflow-x:auto'>.",
  "trap": "Tables are exempt from the reflow rule, but the scroll container must be keyboard-reachable."
 },
 {
  "id": "Z-08",
  "pass": "3 Zoom, reflow & spacing",
  "sc": "1.4.12",
  "level": "AA",
  "verify": "Survives user text spacing",
  "how": "Paste into DevTools: * { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; } p { margin-bottom: 2em !important; }",
  "passCriterion": "No clipped labels, no overlapping text, no content that disappears.",
  "trap": "You do not have to IMPLEMENT these values — you have to SURVIVE them. Fixed heights and overflow:hidden are the two patterns that break. The criterion says 'no loss', not 'no reflow' — growing taller is fine."
 },
 {
  "id": "Z-09",
  "pass": "3 Zoom, reflow & spacing",
  "sc": "1.4.12",
  "level": "AA",
  "verify": "Clamped text is not lost",
  "how": "Find every -webkit-line-clamp truncation.",
  "passCriterion": "The clamped content is reachable some other way.",
  "trap": "If clamped content is unreachable, that is loss of content."
 },
 {
  "id": "Z-10",
  "pass": "3 Zoom, reflow & spacing",
  "sc": "1.3.4",
  "level": "AA",
  "verify": "Both orientations are usable",
  "how": "BrowserStack real device. Rotate to landscape and back.",
  "passCriterion": "Content remains usable in both. No 'please rotate your device' interstitial.",
  "trap": "screen.orientation.lock() calls; 'orientation' in the PWA manifest; @media (orientation: landscape) { .app { display: none } }. The essential-purpose exemption is narrow — a cheque-imaging screen may qualify; a dashboard does not."
 },
 {
  "id": "C-01",
  "pass": "4 Colour & non-text contrast",
  "sc": "1.4.1",
  "level": "A",
  "verify": "Read this first: 1.4.1 vs 1.4.3 vs 1.4.11",
  "how": "Orientation row — no test. Read before running C-02 to C-17.",
  "passCriterion": "1.4.1 = is information carried by colour ALONE? (grayscale test). 1.4.3 = does TEXT reach 4.5:1 against its background? 1.4.11 = do UI COMPONENTS and graphics reach 3:1 against adjacent colour? Three different questions.",
  "trap": "A text link is TEXT — 1.4.11 does not apply to it. A link needs 4.5:1 vs background (1.4.3) and, if colour-only, 3:1 vs SURROUNDING TEXT (1.4.1/G183). These are separate, additive requirements and the team will conflate them."
 },
 {
  "id": "C-02",
  "pass": "4 Colour & non-text contrast",
  "sc": "1.4.1",
  "level": "A",
  "verify": "Body links: decide the route first (G183)",
  "how": "Look at a link inside a paragraph in its DEFAULT state. Does it carry a non-colour cue — underline, border, background, font styling?",
  "passCriterion": "YES = Route A. It passes outright; C-03 and C-04 are N/A for this template. NO = Route B, and BOTH C-03 and C-04 now become mandatory.",
  "trap": "There is no SC that says 'underline your links' — this is 1.4.1 Use of Color, satisfied via technique G183. Route A is the safe default. Route B is a tight needle and most teams miss half of it. Note: 1.4.11 does NOT apply to text links — a text link is text, not a UI component."
 },
 {
  "id": "C-03",
  "pass": "4 Colour & non-text contrast",
  "sc": "1.4.1",
  "level": "A",
  "verify": "Route B only: link colour reaches 3:1 against the SURROUNDING TEXT",
  "how": "Measure the link colour against the surrounding body text colour. NOT against the background.",
  "passCriterion": "3:1 minimum against the adjacent text colour.",
  "trap": "The measurement everyone gets wrong — they measure against the background and call it done. That is 1.4.3, a SEPARATE and additional requirement (4.5:1 vs background). A Route B link must clear BOTH."
 },
 {
  "id": "C-04",
  "pass": "4 Colour & non-text contrast",
  "sc": "1.4.1",
  "level": "A",
  "verify": "Route B only: a non-colour cue appears on hover AND on focus  <== YOUR CASE",
  "how": "Grayscale the page. Hover the link. Then, separately, keyboard-focus it.",
  "passCriterion": "In BOTH states a non-colour cue appears — an underline appears, a background, a border, a weight change. Perceptible in grayscale.",
  "trap": "This is the half of Route B that gets dropped, and dropping it fails 1.4.1 outright. axe cannot automate it — where a link clears 3:1 with no distinct style, the rule explicitly hands it back for manual review. 'Focus' is the more-missed of the two: teams style :hover and forget :focus-visible."
 },
 {
  "id": "C-05",
  "pass": "4 Colour & non-text contrast",
  "sc": "1.4.1",
  "level": "A",
  "verify": "Grayscale test: no information is lost anywhere else",
  "how": "DevTools > Rendering > Emulate vision deficiencies > Achromatopsia. Or apply filter: grayscale(1) to <html>.",
  "passCriterion": "Every piece of information still readable.",
  "trap": "The fastest 1.4.1 test there is, and it covers the parts of the SC that link-in-text-block never touches. Anything that vanishes is a failure."
 },
 {
  "id": "C-06",
  "pass": "4 Colour & non-text contrast",
  "sc": "1.4.1",
  "level": "A",
  "verify": "Chart series are not keyed by colour alone",
  "how": "Grayscale every chart.",
  "passCriterion": "Series distinguished by dash pattern, marker shape or fill — and prefer a direct label on each series over a colour-keyed legend.",
  "trap": "Universal on financial dashboards. A grayscale multi-line chart with a colour legend is unreadable. Zero automated coverage."
 },
 {
  "id": "C-07",
  "pass": "4 Colour & non-text contrast",
  "sc": "1.4.1",
  "level": "A",
  "verify": "Status indicators carry a text label",
  "how": "Grayscale every status pill, badge, dot and traffic-light.",
  "passCriterion": "The status is still readable as text.",
  "trap": "Green dot = active, red dot = suspended, with no text anywhere. Zero automated coverage."
 },
 {
  "id": "C-08",
  "pass": "4 Colour & non-text contrast",
  "sc": "1.4.11",
  "level": "AA",
  "verify": "Input and control borders reach 3:1",
  "how": "Measure every input, select and textarea border against the page background.",
  "passCriterion": "3:1 minimum. #767676 is the lightest gray that reaches 3:1 against white.",
  "trap": "NO SCANNER CHECKS THIS. axe-core has no non-text contrast rule at all. Light-gray borders are the default in most design systems."
 },
 {
  "id": "C-09",
  "pass": "4 Colour & non-text contrast",
  "sc": "1.4.11",
  "level": "AA",
  "verify": "Focus ring reaches 3:1 against every surface",
  "how": "Tab to controls on white, on grey cards, on the dark footer, on brand-coloured banners. Measure at each.",
  "passCriterion": "3:1 against BOTH the component and the adjacent page background, on every surface it can appear over.",
  "trap": "A ring tuned for white fails on the dark footer. Test on every surface colour it can land on."
 },
 {
  "id": "C-10",
  "pass": "4 Colour & non-text contrast",
  "sc": "1.4.11",
  "level": "AA",
  "verify": "Custom checkbox / radio / toggle states reach 3:1",
  "how": "Measure the boundary against the page, AND the check mark against its own fill.",
  "passCriterion": "Both reach 3:1.",
  "trap": "The tick inside a checked box is the most-missed measurement on the page."
 },
 {
  "id": "C-11",
  "pass": "4 Colour & non-text contrast",
  "sc": "1.4.11",
  "level": "AA",
  "verify": "Solid-fill buttons with no border reach 3:1 against the page",
  "how": "Measure the button fill against the surrounding page.",
  "passCriterion": "3:1.",
  "trap": "A white button on a white page is a failure regardless of how good its label contrast is."
 },
 {
  "id": "C-12",
  "pass": "4 Colour & non-text contrast",
  "sc": "1.4.11",
  "level": "AA",
  "verify": "Meaning-bearing graphics reach 3:1",
  "how": "Measure chart strokes, pie slices, icons that carry meaning, and required-field markers.",
  "passCriterion": "3:1. Purely decorative styling is exempt.",
  "trap": "Chart strokes at brand-pastel values."
 },
 {
  "id": "C-13",
  "pass": "4 Colour & non-text contrast",
  "sc": "1.4.3",
  "level": "AA",
  "verify": "Text over images / gradients / video reaches 4.5:1",
  "how": "Measure at the WORST pixel, not the average.",
  "passCriterion": "4.5:1 guaranteed at every pixel, via a solid scrim (rgba(0,0,0,.6)) or a substantial text shadow.",
  "trap": "Hero banners. axe returns INCOMPLETE here because it cannot resolve the background — an incomplete is NOT a pass."
 },
 {
  "id": "C-14",
  "pass": "4 Colour & non-text contrast",
  "sc": "1.4.3",
  "level": "AA",
  "verify": "Every interactive state meets contrast",
  "how": "Measure default, hover, focus, active, visited, error and selected states.",
  "passCriterion": "4.5:1 normal text, 3:1 large text (18pt/24px, or 14pt/18.66px bold).",
  "trap": "The scanner only sees the default state. Hover and focus states routinely lose contrast."
 },
 {
  "id": "C-15",
  "pass": "4 Colour & non-text contrast",
  "sc": "1.4.3",
  "level": "AA",
  "verify": "Placeholder text reaches 4.5:1",
  "how": "Measure every placeholder.",
  "passCriterion": "4.5:1. Placeholder text is real text.",
  "trap": "'The single most common violation in the wild, because browser default placeholder gray fails.' #999 on white is 2.85:1."
 },
 {
  "id": "C-16",
  "pass": "4 Colour & non-text contrast",
  "sc": "1.4.3",
  "level": "AA",
  "verify": "'Disabled-looking but operable' controls meet contrast",
  "how": "Find every control that looks disabled. Try to click it.",
  "passCriterion": "If it is operable, it must meet contrast. Only TRULY disabled controls are exempt.",
  "trap": "Greyed-out-but-clickable is a failure. So is a greyed-out control that is still in the tab order."
 },
 {
  "id": "C-17",
  "pass": "4 Colour & non-text contrast",
  "sc": "1.4.3",
  "level": "AA",
  "verify": "Text rendered in canvas / SVG / CSS background images meets contrast",
  "how": "Manually sample. The scanner cannot read these.",
  "passCriterion": "4.5:1.",
  "trap": "Charting libraries that render axis labels into <canvas> are invisible to axe."
 },
 {
  "id": "M-01",
  "pass": "5 Motion, timing & media",
  "sc": "2.2.2",
  "level": "A",
  "verify": "Any motion over 5 seconds can be paused, stopped or hidden  <== YOUR CASE",
  "how": "Load the page. Watch for 6 seconds. Look for a control.",
  "passCriterion": "An accessible pause/stop/hide control exists.",
  "trap": "Auto-rotating hero carousels with no pause button. The most common 2.2.2 failure on every corporate site."
 },
 {
  "id": "M-02",
  "pass": "5 Motion, timing & media",
  "sc": "2.2.2",
  "level": "A",
  "verify": "Carousel pause control is visible and keyboard-reachable",
  "how": "Tab to it. Activate it.",
  "passCriterion": "Visible, focusable, has a real accessible name, and actually stops rotation.",
  "trap": "A pause control that only appears on hover is unreachable by keyboard."
 },
 {
  "id": "M-03",
  "pass": "5 Motion, timing & media",
  "sc": "2.2.2",
  "level": "A",
  "verify": "Rotation stops on hover AND on focus",
  "how": "Hover the carousel. Separately, Tab into it.",
  "passCriterion": "Rotation pauses in both cases.",
  "trap": "focusin is the one teams forget — a keyboard user reading slide 2 gets yanked to slide 3 mid-read."
 },
 {
  "id": "M-04",
  "pass": "5 Motion, timing & media",
  "sc": "2.2.2",
  "level": "A",
  "verify": "Animated GIFs do not loop past 5 seconds",
  "how": "Find every .gif. Watch it.",
  "passCriterion": "Either it stops within 5s, or it has been converted to <video> with controls / a stoppable APNG or WebP.",
  "trap": "Animated GIFs CANNOT be paused. There is no fix other than converting the asset."
 },
 {
  "id": "M-05",
  "pass": "5 Motion, timing & media",
  "sc": "2.2.2",
  "level": "A",
  "verify": "Auto-updating content can be paused",
  "how": "Watch tickers, live prices, notification counts, feeds.",
  "passCriterion": "A pause control or a manual refresh option exists. If it must auto-update, it uses aria-live='polite' and never moves focus.",
  "trap": "Live market data is the obvious one for a broker site. DOM churn interrupts a screen reader mid-sentence."
 },
 {
  "id": "M-06",
  "pass": "5 Motion, timing & media",
  "sc": "2.2.2",
  "level": "A",
  "verify": "prefers-reduced-motion is honoured",
  "how": "OS: enable Reduce Motion. Or DevTools > Rendering > Emulate prefers-reduced-motion.",
  "passCriterion": "Animations are suppressed.",
  "trap": "The single highest-leverage block of CSS available for this SC."
 },
 {
  "id": "M-07",
  "pass": "5 Motion, timing & media",
  "sc": "1.4.2",
  "level": "A",
  "verify": "No audio autoplays for more than 3 seconds",
  "how": "Load the page with speakers on. Listen.",
  "passCriterion": "Either nothing plays, or a pause/stop/mute control exists near the start of the page.",
  "trap": "Background audio drowns out a screen reader user's synthesizer entirely."
 },
 {
  "id": "M-08",
  "pass": "5 Motion, timing & media",
  "sc": "1.4.2",
  "level": "A",
  "verify": "If audio does autoplay, the control is the FIRST focusable element",
  "how": "Press Tab once.",
  "passCriterion": "The pause/mute control is the first stop, keyboard operable, with a real accessible name.",
  "trap": "A screen reader user cannot hunt for a mute button while audio talks over their synthesizer."
 },
 {
  "id": "M-09",
  "pass": "5 Motion, timing & media",
  "sc": "1.4.2",
  "level": "A",
  "verify": "Autoplay video is muted by default",
  "how": "Inspect the <video> tag.",
  "passCriterion": "autoplay is only ever set together with muted. An explicit unmute control is provided.",
  "trap": "Hero background video with sound."
 },
 {
  "id": "M-10",
  "pass": "5 Motion, timing & media",
  "sc": "2.3.1",
  "level": "A",
  "verify": "Nothing flashes more than three times per second",
  "how": "Run suspect content through PEAT. Audit CSS keyframes that toggle opacity or background-color rapidly, and JS blink loops.",
  "passCriterion": "Nothing flashes more than 3x/second. Do not try to compute whether you sit under the general or red flash threshold — the safe design is not to flash.",
  "trap": "SAFETY CRITERION. A violation can cause a seizure. Saturated red flashing has a stricter threshold."
 },
 {
  "id": "M-11",
  "pass": "5 Motion, timing & media",
  "sc": "1.2.2",
  "level": "A",
  "verify": "Prerecorded video has accurate captions",
  "how": "Play with sound off. Read the captions.",
  "passCriterion": "Synchronised, accurate, human-corrected. Speaker identification ([Priya]:) and meaningful non-speech audio ([alarm beeping]) both present.",
  "trap": "Auto-generated captions left uncorrected — wrong names, wrong technical terms (every SEBI term will be mangled), no punctuation. ASR is a starting point, never a deliverable."
 },
 {
  "id": "M-12",
  "pass": "5 Motion, timing & media",
  "sc": "1.2.2",
  "level": "A",
  "verify": "Caption track is correctly declared",
  "how": "Inspect the <track> element.",
  "passCriterion": "kind='captions' (NOT kind='subtitles'), marked default so captions are on without hunting through a menu.",
  "trap": "subtitles assume the viewer can hear. On third-party players (YouTube, Vimeo, Brightcove), upload a corrected caption file rather than accepting the platform ASR output."
 },
 {
  "id": "M-13",
  "pass": "5 Motion, timing & media",
  "sc": "1.2.1",
  "level": "A",
  "verify": "Audio-only content has a discoverable transcript",
  "how": "Find the transcript.",
  "passCriterion": "It is ON THE PAGE (a <details> disclosure under the player works well), covers the full content, and if linked out the link says 'Transcript for [title]', not 'Transcript'.",
  "trap": "Podcasts and recorded webinars published with no transcript."
 },
 {
  "id": "M-14",
  "pass": "5 Motion, timing & media",
  "sc": "1.2.1",
  "level": "A",
  "verify": "Video-only content has a transcript or descriptive audio track",
  "how": "Find the alternative.",
  "passCriterion": "Present and complete.",
  "trap": "Silent explainer/product videos. Do not rely on <track kind='descriptions'> — browser support is effectively nonexistent."
 },
 {
  "id": "M-15",
  "pass": "5 Motion, timing & media",
  "sc": "1.2.5",
  "level": "AA",
  "verify": "Prerecorded synchronised media has an actual audio description",
  "how": "Watch with the screen off. Note everything you lost. Then check for a described track.",
  "passCriterion": "Either the narration is self-describing, OR a described audio track / 'Audio described version' player exists and is clearly labelled.",
  "trap": "THE AA TRAP: the transcript that passed 1.2.3 at Level A does NOT pass 1.2.5 at Level AA. You need an actual audio track. Cheapest fix is upstream — brief the video team to narrate what is on screen."
 },
 {
  "id": "M-16",
  "pass": "5 Motion, timing & media",
  "sc": "1.2.3",
  "level": "A",
  "verify": "Visual-only information in video is spoken or described",
  "how": "Listen with the screen off. Note every on-screen URL, code sample, diagram or number never said aloud.",
  "passCriterion": "Everything appears in the description or the text alternative.",
  "trap": "'As you can see here' with no description of what 'here' shows."
 },
 {
  "id": "M-17",
  "pass": "5 Motion, timing & media",
  "sc": "1.2.4",
  "level": "AA",
  "verify": "Live streams have real-time captions",
  "how": "Attend the live stream.",
  "passCriterion": "Captions appear in real time, via CART (a human stenographer) or an accepted real-time ASR service.",
  "trap": "Adding captions after the event does NOT satisfy this — a recording of a live event becomes prerecorded media governed by 1.2.2. This is a procurement and budget decision."
 },
 {
  "id": "S-01",
  "pass": "6 Screen reader",
  "sc": "1.1.1",
  "level": "A",
  "verify": "Informative alt text conveys equivalent information",
  "how": "For every meaningful image ask: if this image vanished, would information be lost? Then read its alt.",
  "passCriterion": "The alt describes the INFORMATION, not the picture. 'Revenue grew from $2M in 2023 to $5M in 2025', not 'chart'.",
  "trap": "Filename-as-alt. 'chart' and nothing more. Never start alt with 'image of' — the screen reader already says 'graphic'."
 },
 {
  "id": "S-02",
  "pass": "6 Screen reader",
  "sc": "1.1.1",
  "level": "A",
  "verify": "Decorative images are hidden from AT",
  "how": "Check the accessibility tree, not the markup.",
  "passCriterion": "alt='' (the attribute PRESENT and empty — not missing) and absent from the tree.",
  "trap": "Decorative images given descriptive alt text. Dividers, spacers and background flourishes announced to the user."
 },
 {
  "id": "S-03",
  "pass": "6 Screen reader",
  "sc": "1.1.1",
  "level": "A",
  "verify": "Icon-only controls have an accessible name",
  "how": "Check every icon-only button and link in the accessibility pane.",
  "passCriterion": "A real name via aria-label, with the icon marked aria-hidden='true' focusable='false'.",
  "trap": "Unnamed X, hamburger, search, filter, download and kebab-menu buttons."
 },
 {
  "id": "S-04",
  "pass": "6 Screen reader",
  "sc": "1.1.1",
  "level": "A",
  "verify": "Alt text does not duplicate adjacent visible text",
  "how": "Listen to any icon-plus-label pair.",
  "passCriterion": "Announced once, not twice.",
  "trap": "If an icon sits next to a visible text label, mark the icon aria-hidden='true'."
 },
 {
  "id": "S-05",
  "pass": "6 Screen reader",
  "sc": "1.1.1",
  "level": "A",
  "verify": "Complex charts have a full text equivalent",
  "how": "Check each chart and infographic.",
  "passCriterion": "A short alt on the image PLUS an adjacent data table or text description.",
  "trap": "Alt text saying 'chart'. Also: CSS background images cannot carry alt text, so they must never be used for meaningful content."
 },
 {
  "id": "S-06",
  "pass": "6 Screen reader",
  "sc": "1.3.1",
  "level": "A",
  "verify": "Headings are real elements at the right level",
  "how": "Pull up the heading list (NVDA: Insert+F7). Then disable CSS and re-read.",
  "passCriterion": "Real <h1>-<h6>, no skipped levels, and the level reflects HIERARCHY not size.",
  "trap": "<div class='heading'> styled with CSS. Choosing the level that 'looks right'. Style headings with CSS classes, never by picking the level."
 },
 {
  "id": "S-07",
  "pass": "6 Screen reader",
  "sc": "2.4.6",
  "level": "AA",
  "verify": "Headings form a usable outline",
  "how": "Read the heading list in isolation, with no page context.",
  "passCriterion": "It reads as a usable table of contents for the page.",
  "trap": "'Section 1, Section 2, Section 3'. THE SOURCE PDF IS EXPLICIT: no automated tool detects this. 1.3.1 covers whether it is a real <h2>; 2.4.6 covers whether the text is any good."
 },
 {
  "id": "S-08",
  "pass": "6 Screen reader",
  "sc": "2.4.6",
  "level": "AA",
  "verify": "Repeated headings are distinguishable in context",
  "how": "Look for identical headings in the heading list.",
  "passCriterion": "Each is distinguishable — the product/scheme/fund name is included.",
  "trap": "Four product cards each with <h3>Details</h3> reads as 'Details, Details, Details, Details'. Headings need not be unique, but must be distinguishable."
 },
 {
  "id": "S-09",
  "pass": "6 Screen reader",
  "sc": "2.4.6",
  "level": "AA",
  "verify": "Labels are specific",
  "how": "Read every form label and control name in isolation.",
  "passCriterion": "'Email address' beats 'Email'. 'Search products' beats 'Search'.",
  "trap": "Where a table's rows each contain an identically-labelled control, extend the name with the row context via aria-labelledby referencing both the control label and the row header."
 },
 {
  "id": "S-10",
  "pass": "6 Screen reader",
  "sc": "1.3.1",
  "level": "A",
  "verify": "Landmark structure is present and distinct",
  "how": "Navigate by landmark (NVDA: D).",
  "passCriterion": "Exactly one <main>. <header>, <nav>, <footer> present. Each repeated <nav> has a distinct aria-label.",
  "trap": "Two <nav> elements both announced as 'navigation' with no way to tell them apart."
 },
 {
  "id": "S-11",
  "pass": "6 Screen reader",
  "sc": "1.3.1",
  "level": "A",
  "verify": "Data tables are properly marked up",
  "how": "Navigate by table. Move cell to cell.",
  "passCriterion": "<th> with scope, and a <caption>. Row and column headers announced with each cell.",
  "trap": "Never use <table> for layout; if you inherit one, add role='presentation'."
 },
 {
  "id": "S-12",
  "pass": "6 Screen reader",
  "sc": "1.3.2",
  "level": "A",
  "verify": "Reading order survives CSS being disabled",
  "how": "Disable CSS entirely. Read the page top to bottom.",
  "passCriterion": "It still reads as a coherent document.",
  "trap": "The definitive 1.3.2 test. Write the DOM in reading order and let CSS handle placement."
 },
 {
  "id": "S-13",
  "pass": "6 Screen reader",
  "sc": "1.3.2",
  "level": "A",
  "verify": "Visual order does not diverge from DOM order",
  "how": "Look for CSS order, flex-direction: row-reverse, grid-area and absolute positioning. Compare visual position to Tab order.",
  "passCriterion": "They match.",
  "trap": "Screen readers and the tab sequence follow the DOM and ignore order/row-reverse/grid-area entirely. THERE IS NO ARIA ATTRIBUTE THAT REPAIRS THIS — the markup must be fixed."
 },
 {
  "id": "S-14",
  "pass": "6 Screen reader",
  "sc": "2.4.4",
  "level": "A",
  "verify": "Every link's purpose is clear from its name PLUS its context",
  "how": "Pull up the links list (NVDA: Insert+F7 > Links). For any link whose name is not self-sufficient, go back to the page and read the sentence, paragraph, list item or table cell it sits in.",
  "passCriterion": "The purpose is determinable from the name ALONE, or from the name TOGETHER WITH its programmatically determined context.",
  "trap": "Context that COUNTS at Level A: the enclosing sentence, paragraph, list item, table cell or <th>. Context that does NOT count: a nearby heading. So a bare 'Read more' in a card with only a heading above it FAILS — the heading is not programmatic context. The same 'Read more' inside a descriptive sentence PASSES."
 },
 {
  "id": "S-15",
  "pass": "6 Screen reader",
  "sc": "2.4.4",
  "level": "A",
  "verify": "ADVISORY: links that are not self-sufficient in the links list",
  "how": "Read the links list cold. Note every 'Click here' / 'Read more' / 'Learn more' / bare URL, even where S-14 context saves it.",
  "passCriterion": "Log as ADVISORY, not as a defect. Requiring the name to stand alone is 2.4.9 Link Purpose (Link Only) — LEVEL AAA — and is out of scope for an AA claim.",
  "trap": "DO NOT RAISE THESE AS AA DEFECTS. Over-reporting here is the fastest way to lose an argument with a client's dev team and have them discount the rest of the report. Fix is still worth recommending: <a href='/report'>Read more<span class='visually-hidden'> about the 2025 accessibility report</span></a> — the visually-hidden span extends the name without tripping 2.5.3, which aria-label would."
 },
 {
  "id": "S-16",
  "pass": "6 Screen reader",
  "sc": "2.4.4",
  "level": "A",
  "verify": "Image link and text link to the same destination are not announced twice",
  "how": "Listen to card links and logo links.",
  "passCriterion": "Both are wrapped in ONE <a>, with the image given alt=''.",
  "trap": "The same destination announced twice in a row in the links list."
 },
 {
  "id": "S-17",
  "pass": "6 Screen reader",
  "sc": "4.1.2",
  "level": "A",
  "verify": "Custom widget states are present AND update live",
  "how": "Interact with every accordion, toggle, tab set, disclosure and combobox while watching the accessibility pane.",
  "passCriterion": "aria-expanded / aria-checked / aria-pressed / aria-selected are present and CHANGE as the user interacts.",
  "trap": "THE MOST COMMON BUG: the attribute exists but never changes. A stale aria-expanded='false' on an open panel is WORSE than no attribute — it actively lies to the user. And it is a clean scanner pass."
 },
 {
  "id": "S-18",
  "pass": "6 Screen reader",
  "sc": "4.1.2",
  "level": "A",
  "verify": "Modals are correctly identified",
  "how": "Inspect every modal.",
  "passCriterion": "role='dialog', aria-modal='true', and an accessible name via aria-labelledby.",
  "trap": "Prefer native <dialog> + showModal() — it gives containment and inertness for free."
 },
 {
  "id": "S-19",
  "pass": "6 Screen reader",
  "sc": "4.1.2",
  "level": "A",
  "verify": "Custom widgets match their APG pattern",
  "how": "Verify each against the ARIA Authoring Practices Guide pattern for that role.",
  "passCriterion": "Roles, required child roles, states and keyboard model all match.",
  "trap": "Comboboxes missing aria-expanded / aria-controls / aria-activedescendant. Tabs missing role='tab' / 'tablist' / 'tabpanel'. THE FIRST RULE OF ARIA IS: DON'T USE ARIA — a native element gives you name, role, value and state for free."
 },
 {
  "id": "S-20",
  "pass": "6 Screen reader",
  "sc": "2.4.2",
  "level": "AA",
  "verify": "SPA route change updates the title AND announces",
  "how": "Navigate client-side with NVDA running.",
  "passCriterion": "document.title updates in the router, AND a live region announces the new page.",
  "trap": "Browsers do NOT fire a page-load announcement for client-side navigation. Both halves are needed."
 },
 {
  "id": "P-01",
  "pass": "7 Content & copy",
  "sc": "1.3.3",
  "level": "A",
  "verify": "No instruction relies on shape, colour, size, position or sound alone",
  "how": "Search the string catalogue / CMS for: left, right, above, below, green, red, round, icon, below the fold.",
  "passCriterion": "Every reference names the control: 'Press the Continue button (the round button on the right)'. Sensory detail may SUPPLEMENT, never substitute.",
  "trap": "'Click the round green button'. 'See the box on the right'. This lives in content files and i18n bundles, not components — worth a lint rule."
 },
 {
  "id": "P-02",
  "pass": "7 Content & copy",
  "sc": "1.4.5",
  "level": "AA",
  "verify": "Text is real text, not an image of text",
  "how": "Try to select the text with the cursor.",
  "passCriterion": "If you cannot select it and it is not a logo, it is a failure.",
  "trap": "Marketing headlines, banners, buttons, pricing tables and rate cards shipped as flat images. Also breaks translation, search indexing and high-DPI rendering."
 },
 {
  "id": "P-03",
  "pass": "7 Content & copy",
  "sc": "1.4.5",
  "level": "AA",
  "verify": "No text baked into CSS background images",
  "how": "Inspect background-image URLs. Open each asset.",
  "passCriterion": "No meaningful text inside them.",
  "trap": "axe CANNOT detect this — it requires manual review. Logos and brand wordmarks are explicitly exempt."
 },
 {
  "id": "P-04",
  "pass": "7 Content & copy",
  "sc": "2.4.2",
  "level": "A",
  "verify": "Every page has a unique, specific title",
  "how": "Read the <title> on every page in the sample.",
  "passCriterion": "Unique, descriptive, MOST SPECIFIC INFORMATION FIRST: 'Checkout — Shopping Cart — Acme Store'.",
  "trap": "Every page titled 'Home'. Screen reader users hear the beginning of the title and tab strips truncate the end."
 },
 {
  "id": "P-05",
  "pass": "7 Content & copy",
  "sc": "2.5.3",
  "level": "A",
  "verify": "Controls with visible text have no conflicting aria-label",
  "how": "Read the COMPUTED ACCESSIBLE NAME in DevTools, not the markup.",
  "passCriterion": "The accessible name CONTAINS the visible string, and leads with it.",
  "trap": "<button aria-label='Continue to payment'>Next</button> — the user says 'click Next' and nothing matches. Silently breaks Dragon and Voice Control. RULE OF THUMB: if a control has visible text, do not give it an aria-label."
 },
 {
  "id": "P-06",
  "pass": "7 Content & copy",
  "sc": "2.5.3",
  "level": "A",
  "verify": "Names injected via title / aria-labelledby / framework props are checked",
  "how": "Check the computed name for every control, especially design-system components.",
  "passCriterion": "No silent override of the visible string.",
  "trap": "Framework props that quietly inject labels. Check the tree, not the JSX."
 },
 {
  "id": "P-07",
  "pass": "7 Content & copy",
  "sc": "3.1.1",
  "level": "A",
  "verify": "html lang is present, valid, and matches the content",
  "how": "Read <html lang='...'> on every page.",
  "passCriterion": "A valid BCP 47 tag that matches the ACTUAL content language.",
  "trap": "The scanner checks presence and validity. It cannot check MATCH — lang='en' on a Hindi page passes. In an SPA with a language switcher, update document.documentElement.lang on locale change."
 },
 {
  "id": "P-08",
  "pass": "7 Content & copy",
  "sc": "3.1.2",
  "level": "AA",
  "verify": "Foreign-language passages carry lang",
  "how": "Find every passage or phrase in a different language.",
  "passCriterion": "lang is set on a wrapping element.",
  "trap": "Exempt: proper names, technical terms, and loanwords now part of the surrounding language. Heuristic: if an ordinary speaker of the page's language would pronounce it as their own word, no lang is needed."
 },
 {
  "id": "P-09",
  "pass": "7 Content & copy",
  "sc": "3.1.2",
  "level": "AA",
  "verify": "Language switcher options carry lang and hreflang",
  "how": "Inspect the language switcher.",
  "passCriterion": "<a href='/hi' lang='hi' hreflang='hi'>हिन्दी</a>",
  "trap": "THE MOST-MISSED INSTANCE of this SC — the link text is by definition in another language. Directly relevant given the regional-language mandate on investor-facing content."
 },
 {
  "id": "P-10",
  "pass": "7 Content & copy",
  "sc": "4.1.1",
  "level": "A",
  "verify": "No duplicate IDs",
  "how": "Run the W3C validator. Fail the build on duplicate IDs at minimum.",
  "passCriterion": "Every id on the page is unique.",
  "trap": "aria-labelledby, aria-describedby, for and aria-controls all resolve to the FIRST match — a reused ID silently points the wrong label at the wrong control. Generate IDs (React useId()), never hard-code them in repeated components. Note: 4.1.1 was REMOVED in WCAG 2.2 as obsolete, but remains in scope for a 2.1 claim."
 },
 {
  "id": "T-01",
  "pass": "8 Pointer & mobile",
  "sc": "2.5.1",
  "level": "A",
  "verify": "Every gesture has a single-pointer alternative",
  "how": "Try to operate every gesture-driven control with a single tap or click.",
  "passCriterion": "Swipe carousel > Prev/Next buttons. Pinch map > +/- buttons. Drag slider > clickable track or steppers. Swipe-to-delete > a visible Delete button. Drag-reorder > Move up/Move down.",
  "trap": "'Path-based' means the PATH matters, not just the endpoints — a swipe is path-based, a tap is not. Using <input type='range'> gives you keyboard operation for free and satisfies both this and 2.1.1."
 },
 {
  "id": "T-02",
  "pass": "8 Pointer & mobile",
  "sc": "2.5.1",
  "level": "A",
  "verify": "Essential-gesture exemptions are genuinely essential",
  "how": "Review anything claimed as exempt.",
  "passCriterion": "The exemption is rare: a freehand drawing canvas or a signature field genuinely requires a path.",
  "trap": "Even for a signature field, offer a typed-name alternative."
 },
 {
  "id": "T-03",
  "pass": "8 Pointer & mobile",
  "sc": "2.5.2",
  "level": "A",
  "verify": "Nothing fires on down-event",
  "how": "Press down on a control, slide the pointer OFF it, release.",
  "passCriterion": "Nothing happens.",
  "trap": "Handlers bound to mousedown / pointerdown / touchstart. Teams do this to shave 100ms of latency — the perceived gain is small and the accessibility cost is real."
 },
 {
  "id": "T-04",
  "pass": "8 Pointer & mobile",
  "sc": "2.5.2",
  "level": "A",
  "verify": "Down-event is used for visual state only",
  "how": "Inspect the handlers.",
  "passCriterion": "click for the action; :active for the press feedback.",
  "trap": "The browser's click event already implements press/slide-off/release correctly. You get compliance for free by not optimising."
 },
 {
  "id": "T-05",
  "pass": "8 Pointer & mobile",
  "sc": "2.5.2",
  "level": "A",
  "verify": "Drag operations can be aborted or undone",
  "how": "Start a drag. Drop outside the target.",
  "passCriterion": "The operation cancels, or a full undo is available.",
  "trap": "Drag operations that commit immediately with no undo."
 },
 {
  "id": "T-06",
  "pass": "8 Pointer & mobile",
  "sc": "2.5.4",
  "level": "A",
  "verify": "Motion-triggered actions have an on-screen equivalent",
  "how": "Find every shake / tilt / wave interaction.",
  "passCriterion": "An equivalent UI control exists.",
  "trap": "'Shake to undo' with no Undo button. Also covers camera-based motion and gyroscope-driven parallax that CHANGES CONTENT."
 },
 {
  "id": "T-07",
  "pass": "8 Pointer & mobile",
  "sc": "2.5.4",
  "level": "A",
  "verify": "Motion actuation can be disabled",
  "how": "Look in settings.",
  "passCriterion": "A toggle exists. Consider honouring prefers-reduced-motion as the default state.",
  "trap": "Both obligations are required — an equivalent control AND a way to turn motion off."
 },
 {
  "id": "T-08",
  "pass": "8 Pointer & mobile",
  "sc": "1.4.13",
  "level": "AA",
  "verify": "Tooltip is HOVERABLE",
  "how": "Hover the trigger. Move the pointer onto the revealed content.",
  "passCriterion": "It stays open while the pointer travels to it and while the pointer is on it.",
  "trap": "MOST TOOLTIP LIBRARIES GET THIS WRONG BY DEFAULT. The content vanishes the instant the cursor leaves the trigger, so it can never be read under magnification."
 },
 {
  "id": "T-09",
  "pass": "8 Pointer & mobile",
  "sc": "1.4.13",
  "level": "AA",
  "verify": "Tooltip is DISMISSIBLE",
  "how": "With the tooltip showing, press Esc. Do not move the pointer or focus.",
  "passCriterion": "It dismisses.",
  "trap": "Hover menus that cannot be dismissed with Esc."
 },
 {
  "id": "T-10",
  "pass": "8 Pointer & mobile",
  "sc": "1.4.13",
  "level": "AA",
  "verify": "Tooltip is PERSISTENT",
  "how": "Reveal it and wait.",
  "passCriterion": "It stays until dismissed, focus moves, or it is no longer valid. Never auto-dismisses on a timer.",
  "trap": "Tooltips that time out and disappear on their own."
 },
 {
  "id": "T-11",
  "pass": "8 Pointer & mobile",
  "sc": "1.4.13",
  "level": "AA",
  "verify": "Tooltip appears on keyboard focus",
  "how": "Tab to the trigger.",
  "passCriterion": "It appears. Bind to :focus-visible as well as :hover.",
  "trap": "Shown on hover but not on keyboard focus — the content is unreachable without a mouse."
 },
 {
  "id": "T-12",
  "pass": "8 Pointer & mobile",
  "sc": "1.4.13",
  "level": "AA",
  "verify": "No dead gap between trigger and tooltip",
  "how": "Move the pointer slowly from trigger to tooltip.",
  "passCriterion": "No gap the pointer can fall into. Bridge it with padding or a transparent pseudo-element.",
  "trap": "Also wire the tooltip to its trigger with aria-describedby so it is announced. Covers hover-triggered nav menus too."
 },
 {
  "id": "X-01",
  "pass": "9 Cross-page / site-level",
  "sc": "2.4.5",
  "level": "AA",
  "verify": "At least two ways to locate a page exist",
  "how": "Count them.",
  "passCriterion": "At least TWO of: site search, HTML sitemap, persistent navigation menu, breadcrumbs, A-Z index, contextual related-links.",
  "trap": "Cheapest pair: navigation menu + site search. Cheapest addition to an existing site: an HTML /sitemap page linked from the footer."
 },
 {
  "id": "X-02",
  "pass": "9 Cross-page / site-level",
  "sc": "2.4.5",
  "level": "AA",
  "verify": "sitemap.xml is not being counted",
  "how": "Check what the second mechanism actually is.",
  "passCriterion": "sitemap.xml does NOT count — it is for crawlers. An HTML sitemap page does.",
  "trap": "Exempt: steps in a process. You need not provide search on step 3 of a checkout."
 },
 {
  "id": "X-03",
  "pass": "9 Cross-page / site-level",
  "sc": "3.2.3",
  "level": "AA",
  "verify": "Repeated navigation keeps the same relative order",
  "how": "Compare the nav across at least 5 pages from different sections.",
  "passCriterion": "The surviving items keep their sequence. RELATIVE order is what matters, not absolute position.",
  "trap": "You may add a section-specific item, hide an irrelevant one, or collapse to a hamburger at mobile. Most violations are per-page nav markup that drifted apart — render from ONE shared component and ONE source of truth."
 },
 {
  "id": "X-04",
  "pass": "9 Cross-page / site-level",
  "sc": "3.2.4",
  "level": "AA",
  "verify": "Same-function components are identified consistently",
  "how": "Inventory repeated components across pages: download, search, share, print, filter, export.",
  "passCriterion": "The accessible name, the icon, and the visible text all match.",
  "trap": "'Download' on one page and 'Save file' on another. The criterion says consistently IDENTIFIED, not identical — 'Search' and 'Search products' can coexist if the extra word genuinely disambiguates."
 },
 {
  "id": "X-05",
  "pass": "9 Cross-page / site-level",
  "sc": "3.2.4",
  "level": "AA",
  "verify": "Icon-to-meaning mapping is consistent site-wide",
  "how": "Map every icon to its meaning across the site.",
  "passCriterion": "One icon, one meaning.",
  "trap": "The same icon meaning 'share' on one page and 'export' on another. Fix at the design-system layer: keys by FUNCTION (action.download), not by page (homepage.downloadBtn)."
 }
];

// v0.4.6 — cases the extension's visual-state check suite (lib/visual-checks.js)
// now machine-assists. The crawler pre-screens these; the auditor reviews the
// flagged findings instead of hand-testing every link/element from scratch.
export const MACHINE_ASSIST = {
  "K-02": "Assisted by eu-focus-suppressed / eu-focus-outline-review — outline-killing CSS detected automatically per page; still tab through flagged pages to confirm",
  "C-02": "Assisted by eu-link-color-only — every text-block link's default state is route-classified automatically (underline/border/bold/bg cue vs colour-only)",
  "C-03": "Assisted by eu-link-color-only — the 3:1 link-vs-surrounding-text ratio is computed automatically for every colour-only link",
  "C-04": "Assisted by eu-link-route-b-states — page CSS scanned for hover/focus cue rules on Route B links; confirm flagged links by hand (JS-driven styles are invisible to the scan)"
};

// Component triggers — decide which crawled pages each test applies to.
// Matched against the test's pass name + verify/how text. First hit wins;
// no hit → the test applies to every page.
const TRIGGERS = [
  { flag: "hasForms",     label: "Pages with forms",             rx: /\bforms?\b|\binput\b|error message|required field|autocomplete|\bsubmit\b/i },
  { flag: "hasModal",     label: "Pages with modals/dialogs",    rx: /\bmodal\b|\bdialog\b|\blightbox\b|\bpopup\b/i },
  { flag: "hasCarousel",  label: "Pages with carousels/sliders", rx: /\bcarousel\b|\bslider\b|auto-?rotat|auto-?advan|auto-?play(?:ing)? (?:content|region)/i },
  { flag: "hasVideo",     label: "Pages with video",             rx: /\bvideo\b|\bcaptions?\b|audio description/i },
  { flag: "hasAudio",     label: "Pages with audio",             rx: /\baudio\b(?!.?description)|\bpodcast\b|\btranscript\b/i },
  { flag: "hasDataTable", label: "Pages with data tables",       rx: /\bdata tables?\b|\btable\b.*\bheader/i },
  { flag: "hasCaptcha",   label: "Pages with CAPTCHA",           rx: /\bcaptcha\b/i },
  { flag: "hasLogin",     label: "Pages with login/auth",        rx: /\blog ?in\b|\bpassword\b|\bauthentication\b|\bsession\b.*\bexpir/i },
  { flag: "hasPdfLinks",  label: "Pages linking to PDFs/docs",   rx: /\bpdf\b|\bdownloadable document/i },
  { flag: "hasIframe",    label: "Pages with iframes/embeds",    rx: /\biframes?\b|\bembed(?:ded)?\b|third-party widget/i }
];

// Pass-level defaults (checked before keyword triggers): the whole
// "Forms & errors" pass is form-scoped regardless of row wording.
const PASS_FLAGS = { "2 Forms & errors": "hasForms" };

export function testApplicability(test, pages) {
  const all = { label: "All pages", urls: [], count: pages ? pages.length : 0 };
  if (!pages || !pages.length) return { label: "All pages", urls: [], count: 0 };
  let trigger = null;
  const passFlag = PASS_FLAGS[test.pass];
  if (passFlag) trigger = TRIGGERS.find(t => t.flag === passFlag) || null;
  if (!trigger) {
    const text = `${test.verify} ${test.how}`;
    trigger = TRIGGERS.find(t => t.rx.test(text)) || null;
  }
  if (!trigger) return all;
  // If NO page carries the flag data at all (multi-page report mode), fall
  // back to "all pages — confirm manually" rather than claiming zero.
  const anyFlagData = pages.some(p => trigger.flag in p);
  if (!anyFlagData) return { label: `${trigger.label} — flags unavailable, confirm manually`, urls: [], count: pages.length };
  const hits = pages.filter(p => p[trigger.flag] === true);
  return {
    label: hits.length ? `${trigger.label} (${hits.length})` : `${trigger.label} — none found by crawler`,
    urls: hits.slice(0, 3).map(p => p.url),
    count: hits.length
  };
}
