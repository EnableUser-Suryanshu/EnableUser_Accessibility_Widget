// Minimal template classifier — enough to group URLs for cross-folder
// dedup, not a full template-type taxonomy. Output is a small fixed set of
// classes used as a secondary grouping key alongside leaf slug + audit
// fingerprint. See collapseCrossFolderDuplicates() in request-queue.js
// for the dedup consumer.
//
// Derived from the EnableUser Site Scope (Python) classify_template_type()
// rules, scoped to the five categories most useful for dedup decisions:
//
//   home           → exact "/" or "/home", "/index", and "/<lang>/"
//                    language-root variants
//   legal          → privacy, terms, cookies, disclaimer, gdpr,
//                    accessibility-statement, imprint, impressum, legal
//   auth           → login, signin, sign-in, signup, sign-up, register,
//                    registration, password, forgot, reset
//   blog-post      → deep slug under a blog/news/post/article namespace,
//                    i.e. a leaf content page in a content archive
//   html-sitemap   → /sitemap.html, /sitemap, /site-map, /site-index
//   other          → everything else (default)
//
// The classifier is URL-only — no DOM access. It's deliberately cautious:
// ambiguous cases fall through to "other" so dedup stays conservative.
// This file has no dependencies and is safe to import from both the
// service worker and any content-script utility module.

const LEGAL_SLUGS = [
  "privacy", "privacy-policy", "privacypolicy",
  "terms", "terms-of-service", "terms-of-use", "terms-and-conditions", "tos",
  "cookies", "cookie-policy", "cookie-notice",
  "disclaimer", "legal-disclaimer",
  "gdpr", "ccpa",
  "accessibility-statement", "accessibility-policy", "a11y-statement",
  "imprint", "impressum",
  "legal", "legal-notice", "legal-notices",
  "copyright", "dmca",
  "refund-policy", "shipping-policy", "return-policy"
];

const AUTH_SLUGS = [
  "login", "log-in", "signin", "sign-in",
  "signup", "sign-up", "register", "registration",
  "logout", "log-out", "signout", "sign-out",
  "forgot", "forgot-password",
  "reset", "reset-password",
  "password", "password-reset",
  "account", "my-account",
  "two-factor", "2fa", "mfa",
  "verify-email", "verify"
];

const HOME_SLUGS = new Set([
  "", "home", "index", "default", "main", "start"
]);

const SITEMAP_SLUGS = new Set([
  "sitemap", "sitemap.html", "site-map", "site-index", "html-sitemap", "site_map"
]);

// Content-archive parent path segments. A URL whose first non-language
// segment matches one of these, AND whose leaf segment is a slug (not
// a home/page/archive slug), is classified as a blog post.
const BLOG_PARENTS = new Set([
  "blog", "blogs", "news", "articles", "article",
  "post", "posts", "stories", "press", "press-releases",
  "insights", "resources", "updates", "media"
]);

// Language-tag prefixes — common pattern "/en/...", "/en-us/...", "/fr/...".
// Used to strip the leading language segment before classifying so that
// /en/privacy is still classified as legal, not "other".
const LANG_RX = /^[a-z]{2}(?:-[a-z]{2,4})?$/i;

function splitSegments(pathname) {
  return pathname.split("/").filter(Boolean);
}

// Strips a leading language tag (if any) and returns the remaining
// segments. `/en/privacy` → ["privacy"], `/en-us/blog/my-post` →
// ["blog","my-post"], `/privacy` → ["privacy"].
function stripLang(segments) {
  if (segments.length > 0 && LANG_RX.test(segments[0])) {
    return segments.slice(1);
  }
  return segments;
}

function lastSlug(segments) {
  if (!segments.length) return "";
  return segments[segments.length - 1].toLowerCase();
}

function containsAnySlug(leaf, table) {
  const l = leaf.toLowerCase();
  for (const s of table) {
    if (l === s || l.startsWith(s + "-") || l.endsWith("-" + s)) return true;
  }
  return false;
}

// Main entry point. Input is a canonical URL string (already through
// canonicalize()). Output is one of the class strings above. Returns
// "other" on any parse error.
export function classifyTemplate(canonicalUrl) {
  let u;
  try { u = new URL(canonicalUrl); } catch { return "other"; }
  const rawSegments = splitSegments(u.pathname);
  const segments = stripLang(rawSegments);

  // HOME — empty path after stripping language, or single segment matching
  // a home slug.
  if (segments.length === 0) return "home";
  if (segments.length === 1 && HOME_SLUGS.has(segments[0].toLowerCase())) return "home";

  const leaf = lastSlug(segments);

  // HTML-SITEMAP — exact leaf match on any known sitemap slug.
  if (SITEMAP_SLUGS.has(leaf)) return "html-sitemap";

  // LEGAL — leaf is (or is a slug-extension of) a known legal slug.
  // Restricted to depth-1 (after language strip) so sub-pages under
  // a deeper path like /about/privacy-team don't false-match. Legal
  // documents in practice live at the root: /privacy, /terms,
  // /en/privacy, /en-us/accessibility-statement.
  if (segments.length === 1 && containsAnySlug(leaf, LEGAL_SLUGS)) return "legal";

  // AUTH — same depth-1 restriction as legal. Auth flows live at root:
  // /login, /signup, /forgot-password, /reset, /en/my-account.
  if (segments.length === 1 && containsAnySlug(leaf, AUTH_SLUGS)) return "auth";

  // BLOG-POST — at least two segments after language strip, first segment
  // is a content-archive namespace, leaf is a slug (not another archive
  // slug). /blog/my-post → blog-post; /blog → other (listing page).
  if (segments.length >= 2 && BLOG_PARENTS.has(segments[0].toLowerCase())) {
    if (!HOME_SLUGS.has(leaf) && !SITEMAP_SLUGS.has(leaf)) {
      return "blog-post";
    }
  }

  return "other";
}

// Helper for dedup grouping — returns the classify output joined with
// the leaf slug (lowercased, language-stripped). Two URLs with the same
// templateSlugKey() are candidates for cross-folder collapse.
export function templateSlugKey(canonicalUrl) {
  let u;
  try { u = new URL(canonicalUrl); } catch { return null; }
  const segments = stripLang(splitSegments(u.pathname));
  const leaf = lastSlug(segments);
  const cls = classifyTemplate(canonicalUrl);
  return `${cls}::${leaf}`;
}
