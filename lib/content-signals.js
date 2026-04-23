// Page content-type detector. Runs in the ISOLATED content-script world
// against the live DOM post-hydration. Emits a flat record of what KIND of
// testing each template/page will need — forms, video/audio, data tables,
// iframes, modals, carousels, PDF links, etc.
//
// Used by:
//   (1) inventory mode (no axe injection) — the whole point is this detector
//       tells the auditor "template X needs forms + carousel + keyboard-trap
//       manual tests" before they commit to an audit.
//   (2) full-audit mode — same signals are attached to the template record
//       so the auditor can still generate a per-template manual checklist.
//
// Written as IIFE exposing window.EU_ContentSignals so it can be injected
// via chrome.scripting.executeScript the same way india-checks / gigw-checks
// are.

(() => {
  if (window.EU_ContentSignals) return;

  // ── Dirty-ish visible-text accumulator — cheap, good enough for bucketing.
  function visibleTextLength() {
    return (document.body?.innerText || "").replace(/\s+/g, " ").trim().length;
  }

  // Shadow-DOM-aware query. Light-DOM tree + all open shadow roots reachable
  // from it. Closed shadow roots are spec-opaque and stay invisible. Bounded
  // by a hard walk cap so a pathological page can't hang the collector.
  const SHADOW_WALK_CAP = 30000;
  function qsaAll(selector, root) {
    const out = [];
    let visited = 0;
    (function walk(node) {
      if (!node || visited > SHADOW_WALK_CAP) return;
      if (typeof node.querySelectorAll !== "function") return;
      try { for (const el of node.querySelectorAll(selector)) out.push(el); } catch {}
      const children = node.querySelectorAll("*");
      for (const el of children) {
        visited++;
        if (visited > SHADOW_WALK_CAP) return;
        if (el.shadowRoot) walk(el.shadowRoot);
      }
    })(root || document);
    return out;
  }
  function qFirst(selector, root) { return qsaAll(selector, root)[0] || null; }

  function collect() {
    const doc = document;

    // ── Forms / inputs ──────────────────────────────────────────────────
    const forms = qsaAll("form");
    const inputs = qsaAll("input, select, textarea");
    const requiredInputs = qsaAll("input[required], select[required], textarea[required], [aria-required='true']");
    const fileInputs = qsaAll("input[type='file']");
    const passwordInputs = qsaAll("input[type='password']");
    const otpInputs = qsaAll("input[autocomplete*='one-time-code'], input[name*='otp' i]");

    // ── Data tables (role-aware) ────────────────────────────────────────
    const tables = qsaAll("table");
    let dataTables = 0;
    for (const t of tables) {
      // "Data" table heuristic: has <th> or is not nested in another table
      if (t.querySelector("th") || t.getAttribute("role") === "table") dataTables++;
    }

    // ── Media ───────────────────────────────────────────────────────────
    const videos = qsaAll("video, [role='video']");
    const audios = qsaAll("audio, [role='audio']");
    const youtube = qsaAll("iframe[src*='youtube.com'], iframe[src*='youtu.be']");
    const vimeo = qsaAll("iframe[src*='vimeo.com']");
    const hasCaptions = qsaAll("track[kind='captions'], track[kind='subtitles']").length > 0;

    // ── Embedded content ────────────────────────────────────────────────
    const iframes = qsaAll("iframe");
    const embeds = qsaAll("embed, object");
    const svgs = qsaAll("svg");

    // ── Interactive widgets (pattern-matched against ARIA + common classes)
    const modals = qsaAll("[role='dialog'], [role='alertdialog'], [aria-modal='true'], .modal, .dialog, [class*='modal' i], [class*='dialog' i]");
    const carousels = qsaAll("[class*='carousel' i], [class*='slider' i], [class*='slideshow' i], [data-carousel], .swiper, .slick, [class*='swiper' i]");
    const tabs = qsaAll("[role='tablist'], [role='tab']");
    const menus = qsaAll("[role='menu'], [role='menuitem'], [aria-haspopup='menu']");
    const accordions = qsaAll("[class*='accordion' i], details > summary");
    const tooltips = qsaAll("[role='tooltip'], [data-tooltip]");
    const datepickers = qsaAll("input[type='date'], input[type='datetime-local'], input[type='month'], input[type='week'], [class*='datepicker' i], [class*='calendar' i][role]");
    const dropdowns = qsaAll("[role='combobox'], [role='listbox'], [aria-haspopup='listbox'], [aria-haspopup='true']");

    // ── Navigation / structure ──────────────────────────────────────────
    const navs = qsaAll("nav, [role='navigation']");
    const mainLandmarks = qsaAll("main, [role='main']");
    const skipLinks = qsaAll("a[href^='#']").filter(a => {
      const href = a.getAttribute("href") || "";
      return /^#(main|content|skip|maincontent|primary)/i.test(href);
    }).length;
    const breadcrumbs = qsaAll("[aria-label*='breadcrumb' i], [class*='breadcrumb' i], nav ol");

    // ── Downloads & external content ────────────────────────────────────
    const pdfLinks = qsaAll("a[href$='.pdf'], a[href*='.pdf?'], a[href*='.pdf#']").length;
    const docLinks = qsaAll("a[href$='.doc'], a[href$='.docx'], a[href$='.xls'], a[href$='.xlsx'], a[href$='.ppt'], a[href$='.pptx'], a[href$='.odt'], a[href$='.ods']").length;
    const externalLinks = qsaAll("a[href^='http']")
      .filter(a => { try { return new URL(a.href).hostname !== location.hostname; } catch { return false; } })
      .length;

    // ── Authentication surface ──────────────────────────────────────────
    const hasLogin = !!qFirst("input[type='password']") ||
                      !!qFirst("button[class*='sign' i], a[href*='login' i], a[href*='signin' i]");
    const hasCaptcha = !!qFirst("[class*='captcha' i], iframe[src*='recaptcha'], iframe[src*='hcaptcha'], iframe[src*='turnstile']");

    // ── Heading structure sanity (depth + skips) ────────────────────────
    const headings = qsaAll("h1, h2, h3, h4, h5, h6");
    const headingLevels = headings.map(h => Number(h.tagName[1]));
    let headingSkips = 0;
    for (let i = 1; i < headingLevels.length; i++) {
      if (headingLevels[i] > headingLevels[i - 1] + 1) headingSkips++;
    }
    const h1Count = qsaAll("h1").length;

    // ── Images / alt ────────────────────────────────────────────────────
    const images = qsaAll("img");
    const imagesNoAlt = images.filter(i => !i.hasAttribute("alt")).length;
    const decorativeImages = images.filter(i => i.getAttribute("alt") === "" || i.getAttribute("role") === "presentation").length;
    const bgImages = qsaAll("[style*='background-image']").length;

    // ── Language surface ────────────────────────────────────────────────
    const htmlLang = doc.documentElement.lang || "";
    const elemsWithLang = qsaAll("[lang]").length;

    // ── Shadow DOM presence (flag kept; reflects hosts we pierced into)
    let shadowRoots = 0;
    try {
      const all = doc.querySelectorAll("*");
      for (const el of all) { if (el.shadowRoot) shadowRoots++; }
    } catch {}

    // ── Animated / motion cues ──────────────────────────────────────────
    const prefersReducedMotionRespected = !!doc.querySelector("style, link[rel='stylesheet']") &&
      /@media[^{]*prefers-reduced-motion/i.test([...doc.querySelectorAll("style")].map(s => s.textContent || "").join("\n"));

    // ── Static vs dynamic classification ────────────────────────────────
    // SPA markers: framework root nodes, embedded state dumps, client-side
    // router elements. An auditor testing an SPA needs different strategies
    // (route-change announcements, focus management on navigation, live
    // regions for async updates) than a static multi-page site.
    const spaMarkers = [];
    if (qFirst("#__next") || qFirst("[data-reactroot]") || qFirst("[data-reactid]")) spaMarkers.push("react");
    if (qFirst("#__nuxt") || qFirst("[data-n-head]") || qFirst("[data-server-rendered]")) spaMarkers.push("nuxt-or-vue-ssr");
    if (qFirst("[ng-version]") || qFirst("[ng-app]")) spaMarkers.push("angular");
    if (qFirst("router-view") || qFirst("router-link") || qFirst("[router-link]")) spaMarkers.push("vue-router");
    if (qFirst("script#__NEXT_DATA__")) spaMarkers.push("next.js");
    if (qFirst("script#__NUXT_DATA__") || qFirst("script[data-n-data]")) spaMarkers.push("nuxt");
    if (qFirst("script[id*='APOLLO' i], script[id*='INITIAL_STATE' i]")) spaMarkers.push("state-hydration");
    if (qFirst("[data-turbo]") || qFirst("turbo-frame")) spaMarkers.push("hotwire-turbo");
    if (qFirst("[data-hydrated]") || qFirst("[data-hk]")) spaMarkers.push("svelte-or-qwik");
    // Dynamic-ness cross-signal: does body have very little text but many
    // script tags? Classic signal of a client-rendered shell.
    const scriptCount = qsaAll("script").length;
    const bodyTextLen = (doc.body?.innerText || "").trim().length;
    const shellSignal = scriptCount > 8 && bodyTextLen < 1000;
    const isSPA = spaMarkers.length > 0 || shellSignal;
    const pageType = isSPA ? "dynamic" : "static";

    // ── Actual values (labels, titles, fields) — auditors need these, not
    // just counts. A scope doc that says "this page has a contact form"
    // is useless; "this page has a contact form with fields: name*, email*,
    // phone, message*" is a scoping deliverable.
    function textOf(el) {
      if (!el) return "";
      const t = (el.getAttribute("aria-label") ||
                 el.getAttribute("title") ||
                 el.textContent || "").replace(/\s+/g, " ").trim();
      return t;
    }
    function labelForInput(input) {
      const id = input.id;
      if (id) {
        const lab = qFirst(`label[for="${CSS.escape ? CSS.escape(id) : id}"]`);
        if (lab) return textOf(lab);
      }
      const parentLabel = input.closest && input.closest("label");
      if (parentLabel) return textOf(parentLabel);
      return input.getAttribute("aria-label") ||
             input.getAttribute("placeholder") ||
             input.getAttribute("name") || "";
    }
    // Forms + fields
    const formDetails = forms.slice(0, 50).map(form => {
      const fields = qsaAll("input, select, textarea", form).slice(0, 100).map(i => ({
        name: i.getAttribute("name") || "",
        type: i.getAttribute("type") || i.tagName.toLowerCase(),
        label: labelForInput(i),
        required: i.hasAttribute("required") || i.getAttribute("aria-required") === "true",
        autocomplete: i.getAttribute("autocomplete") || ""
      }));
      return {
        id: form.id || "",
        action: form.getAttribute("action") || "",
        method: (form.getAttribute("method") || "get").toLowerCase(),
        name: form.getAttribute("name") || form.getAttribute("aria-label") || "",
        fields
      };
    });
    // Modal/dialog titles
    const modalDetails = modals.slice(0, 50).map(m => ({
      role: m.getAttribute("role") || "",
      label: m.getAttribute("aria-label") ||
             textOf(qFirst("[role='heading'], h1, h2, h3, h4, h5, h6", m)) ||
             textOf(qFirst(".modal-title, .dialog-title, [class*='title' i]", m)) || "",
      ariaLabelledBy: m.getAttribute("aria-labelledby") || ""
    }));
    // Tab labels
    const tabDetails = qsaAll("[role='tab']").slice(0, 100).map(t => ({
      label: textOf(t),
      selected: t.getAttribute("aria-selected") === "true"
    }));
    // Menu items (first 200 — enough to characterise a nav)
    const menuItemDetails = qsaAll("[role='menuitem'], nav a[href]").slice(0, 200).map(a => ({
      label: textOf(a),
      href: a.getAttribute("href") || ""
    }));
    // Carousel slides
    const carouselDetails = carousels.slice(0, 20).map(c => {
      const slides = qsaAll("[role='tabpanel'], [class*='slide' i], [data-slide]", c);
      return {
        slideCount: slides.length,
        slideHeadings: slides.slice(0, 20).map(s => textOf(qFirst("h1,h2,h3,h4,h5,h6", s))).filter(Boolean)
      };
    });
    // Table captions + column headers (for data tables)
    const tableDetails = tables.slice(0, 50).filter(t => t.querySelector("th") || t.getAttribute("role") === "table").map(t => ({
      caption: textOf(qFirst("caption", t)),
      summary: t.getAttribute("summary") || "",
      columnHeaders: qsaAll("th", t).slice(0, 50).map(th => textOf(th)).filter(Boolean),
      rowCount: qsaAll("tr", t).length
    }));
    // Buttons with labels (for CTA/inventory)
    const buttonDetails = qsaAll("button, [role='button']").slice(0, 100).map(b => ({
      label: textOf(b),
      disabled: b.hasAttribute("disabled") || b.getAttribute("aria-disabled") === "true"
    })).filter(b => b.label);

    // ── Recommended manual-test checklist — derived, not detected, so the
    // inventory report can pre-populate "what this template needs" per row.
    const recommendedTests = deriveRecommendedTests({
      forms: forms.length, requiredInputs: requiredInputs.length,
      videos: videos.length + youtube.length + vimeo.length, audios: audios.length, hasCaptions,
      dataTables, iframes: iframes.length, modals: modals.length,
      carousels: carousels.length, tabs: tabs.length, menus: menus.length,
      accordions: accordions.length, datepickers: datepickers.length,
      dropdowns: dropdowns.length, pdfLinks, hasLogin, hasCaptcha,
      headingSkips, h1Count
    });

    // Canonical URL — <link rel="canonical"> is the site's self-declared
    // authoritative URL for this page. We use this as the top-priority
    // dedup key in buildInventory (canonical → finalUrl → queued url).
    // Ignores hash, keeps origin/path/query; only accepts http(s).
    let canonicalUrl = "";
    try {
      const link = doc.querySelector('link[rel="canonical"]');
      if (link?.href) {
        const u = new URL(link.href, location.href);
        if (u.protocol === "http:" || u.protocol === "https:") {
          u.hash = "";
          canonicalUrl = u.toString();
        }
      }
    } catch {}

    return {
      url: location.href,
      canonicalUrl,
      title: doc.title || "",
      htmlLang,
      visibleTextLength: visibleTextLength(),
      // Structural element counts
      counts: {
        forms: forms.length,
        inputs: inputs.length,
        requiredInputs: requiredInputs.length,
        fileInputs: fileInputs.length,
        passwordInputs: passwordInputs.length,
        otpInputs: otpInputs.length,
        tables: tables.length,
        dataTables,
        videos: videos.length,
        audios: audios.length,
        youtube: youtube.length,
        vimeo: vimeo.length,
        iframes: iframes.length,
        embeds: embeds.length,
        svgs: svgs.length,
        modals: modals.length,
        carousels: carousels.length,
        tabs: tabs.length,
        menus: menus.length,
        accordions: accordions.length,
        tooltips: tooltips.length,
        datepickers: datepickers.length,
        dropdowns: dropdowns.length,
        navs: navs.length,
        mainLandmarks: mainLandmarks.length,
        skipLinks,
        breadcrumbs: breadcrumbs.length,
        pdfLinks,
        docLinks,
        externalLinks,
        images: images.length,
        imagesNoAlt,
        decorativeImages,
        bgImages,
        elemsWithLang,
        shadowRoots,
        h1Count,
        headingSkips,
        h1: headings.filter(h => h.tagName === "H1").length,
        h2: headings.filter(h => h.tagName === "H2").length,
        h3: headings.filter(h => h.tagName === "H3").length,
        h4: headings.filter(h => h.tagName === "H4").length,
        h5: headings.filter(h => h.tagName === "H5").length,
        h6: headings.filter(h => h.tagName === "H6").length
      },
      // Boolean capability flags — easier for reports to consume than counts.
      flags: {
        hasForms: forms.length > 0,
        hasRequiredInputs: requiredInputs.length > 0,
        hasFileUpload: fileInputs.length > 0,
        hasLogin,
        hasCaptcha,
        hasDataTable: dataTables > 0,
        hasVideo: videos.length + youtube.length + vimeo.length > 0,
        hasAudio: audios.length > 0,
        hasCaptions,
        hasIframe: iframes.length > 0,
        hasModal: modals.length > 0,
        hasCarousel: carousels.length > 0,
        hasTabs: tabs.length > 0,
        hasMenu: menus.length > 0,
        hasAccordion: accordions.length > 0,
        hasDatepicker: datepickers.length > 0,
        hasDropdown: dropdowns.length > 0,
        hasPdfLinks: pdfLinks > 0,
        hasDocLinks: docLinks > 0,
        hasExternalLinks: externalLinks > 0,
        hasShadowDom: shadowRoots > 0,
        respectsReducedMotion: prefersReducedMotionRespected,
        h1Valid: h1Count === 1,
        headingOrderValid: headingSkips === 0,
        isSPA
      },
      pageType,                   // "static" | "dynamic"
      spaMarkers,                  // framework signatures that triggered isSPA
      // Full component inventory — the scoping artifact an auditor actually
      // wants: what forms exist, with which fields, which modals, which tabs.
      components: {
        forms: formDetails,
        modals: modalDetails,
        tabs: tabDetails,
        menuItems: menuItemDetails,
        carousels: carouselDetails,
        tables: tableDetails,
        buttons: buttonDetails
      },
      recommendedTests
    };
  }

  function deriveRecommendedTests(s) {
    // Returns a list of {test, why} entries the auditor should run for
    // this template. Matches the WCAG manual-test checklist convention
    // used by Deque, TPGi, and Level Access.
    const tests = [];
    const add = (test, why) => tests.push({ test, why });

    // Always-required manual tests
    add("Keyboard-only navigation (Tab, Shift-Tab, Enter, Space, arrow keys)", "All interactive content must be reachable and operable without a mouse (WCAG 2.1.1).");
    add("Focus visibility at 2px minimum", "Focus indicator must be visible and distinct (WCAG 2.4.7, 2.4.11).");
    add("Zoom to 400% — no horizontal scroll, no loss of content", "WCAG 1.4.10 (Reflow).");
    add("Text size to 200% — no clipping or overlap", "WCAG 1.4.4 (Resize Text).");
    add("Screen reader pass (NVDA or VoiceOver) — name/role/state announced", "WCAG 4.1.2 (Name, Role, Value).");
    add("Page title is meaningful and page-specific", "WCAG 2.4.2 (Page Titled).");
    add("Language of page declared on <html lang>", "WCAG 3.1.1.");

    if (s.headingSkips > 0) add(`Heading order review (${s.headingSkips} skip(s) detected)`, "Heading levels should not skip (WCAG 1.3.1).");
    if (s.h1Count !== 1) add(`H1 correction (${s.h1Count} H1(s) on page)`, "Exactly one H1 per document is best practice for screen-reader navigation (WCAG 2.4.6).");

    if (s.forms > 0) {
      add("Form error messaging + associated label", "WCAG 3.3.1, 3.3.2, 3.3.3, 3.3.4 — errors must be identified, labels associated, suggestions provided, critical submissions reversible.");
      if (s.requiredInputs > 0) add("Required field indication not by colour alone", "WCAG 1.4.1, 3.3.2.");
      add("Input autocomplete attributes on identification fields", "WCAG 1.3.5 (Identify Input Purpose).");
    }
    if (s.videos > 0) {
      add("Video has captions (WCAG 1.2.2) and audio description (WCAG 1.2.5)", "Prerecorded synchronized media must have captions + audio description.");
      if (!s.hasCaptions) add("Missing <track kind='captions'> detected — check external caption track or third-party player", "WCAG 1.2.2 failure likely.");
    }
    if (s.audios > 0) add("Audio has transcript (WCAG 1.2.1)", "Prerecorded audio-only content must have a text alternative.");
    if (s.dataTables > 0) add("Table header cells use <th>+scope OR id/headers; no layout tables", "WCAG 1.3.1 — programmatically determinable table structure.");
    if (s.iframes > 0) add("Every iframe has a meaningful title attribute", "WCAG 2.4.1, 4.1.2 — iframe identification.");
    if (s.modals > 0) add("Modal: focus trap, Esc to close, focus returns to trigger on close", "WCAG 2.1.2 (No Keyboard Trap), 2.4.3 (Focus Order).");
    if (s.carousels > 0) add("Carousel: pause/stop/hide control, no auto-advance under 5s by default", "WCAG 2.2.2 (Pause/Stop/Hide).");
    if (s.tabs > 0) add("Tab pattern: arrow-key navigation, aria-selected wired to panel", "WAI-ARIA Authoring Practices tabpanel pattern.");
    if (s.menus > 0) add("Menu pattern: arrow-key navigation, Esc to close, roving tabindex", "WAI-ARIA Authoring Practices menu/menubar pattern.");
    if (s.accordions > 0) add("Accordion: button role, aria-expanded state, keyboard-operable", "WAI-ARIA Authoring Practices accordion pattern.");
    if (s.datepickers > 0) add("Date picker: keyboard-operable, announces changes, text fallback available", "WCAG 2.1.1, 4.1.2, 4.1.3.");
    if (s.dropdowns > 0) add("Combobox/listbox: aria-expanded + aria-activedescendant wired", "WCAG 4.1.2.");
    if (s.pdfLinks > 0) add("PDF links: inform format + size; target PDFs are themselves accessible (tagged)", "GIGW §5.2.16 / WCAG 2.4.4 + separate PDF/UA conformance pass.");
    if (s.hasLogin) add("Login: password visibility toggle, no paste-blocking, forgot-password reachable", "WCAG 1.3.5, 3.3.1, 3.3.2.");
    if (s.hasCaptcha) add("CAPTCHA: non-visual alternative (audio or accessible challenge)", "WCAG 1.1.1 (Non-text Content).");

    return tests;
  }

  window.EU_ContentSignals = { collect };
})();
