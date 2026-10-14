"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const html = fs.readFileSync(path.join(__dirname, "feed-generator.html"), "utf8");
const css = fs.readFileSync(path.join(__dirname, "landing.css"), "utf8");

test("public landing has a crawlable SEO entry point and no stale noindex", () => {
  assert.match(html, /name="robots" content="index, follow/);
  assert.match(html, /name="description"/);
  assert.match(html, /rel="canonical" href="https:\/\/listingflow\.ru\//);
  assert.doesNotMatch(html, /name="robots" content="noindex/);
  assert.match(fs.readFileSync(path.join(__dirname, "robots.txt"), "utf8"), /Allow: \/\n/);
  assert.match(fs.readFileSync(path.join(__dirname, "sitemap.xml"), "utf8"), /listingflow\.ru/);
});

test("landing navigation and conversion actions resolve to real targets", () => {
  const landing = html.match(/<main class="landing-screen"[\s\S]*?<\/main>/)?.[0] || "";
  const ids = new Set([...landing.matchAll(/\bid="([^\"]+)"/g)].map(match => match[1]));
  for (const href of [...landing.matchAll(/href="#([^\"]+)"/g)].map(match => match[1])) assert.ok(ids.has(href), `missing landing target #${href}`);
  const actionCount = [...html.matchAll(/data-landing-auth="(login|register)"/g)].length;
  assert.ok(actionCount >= 5);
  assert.match(html, /data-landing-auth="login"/);
  assert.match(html, /id="landingBenefits"/);
  assert.match(html, /id="landingWorkflow"/);
  assert.match(html, /id="landingPrice"/);
  assert.match(html, /id="landingFaq"/);
});

test("landing copy matches implemented capabilities and avoids unsupported promises", () => {
  assert.match(html, /группирует объекты по ЖК/);
  assert.match(html, /постоянную ссылку/);
  assert.match(html, /до 100/);
  assert.match(html, /от 30 мин/);
  assert.match(html, /финальное решение всегда принимает площадка/);
  assert.doesNotMatch(html, /доходят до площадки/);
  assert.doesNotMatch(html, /Домклик<\/span>/);
});

test("landing CSS has explicit narrow viewport protections", () => {
  assert.match(css, /@media\(max-width:420px\)/);
  assert.match(css, /overflow-x:clip/);
  assert.match(css, /overflow-y:auto!important/);
  assert.match(css, /height:auto!important/);
  assert.match(css, /grid-template-columns:1fr/);
  assert.match(css, /prefers-reduced-motion/);
});

test("landing motion is progressive, purposeful and reduced-motion safe", () => {
  assert.match(html, /function setupLandingMotion\(\)/);
  assert.match(html, /landing-motion-enabled/);
  assert.match(html, /IntersectionObserver/);
  assert.match(css, /landingHeroCopyIn/);
  assert.match(css, /landingRevealIn/);
  assert.match(css, /@media\(prefers-reduced-motion:reduce\)/);
  assert.doesNotMatch(css, /transition:\s*all/);
});

test("auth screen cannot leave the workspace shell visible", () => {
  assert.match(html, /document\.body\.classList\.add\("auth-active"\)/);
  assert.match(html, /document\.body\.classList\.remove\("auth-active", "landing-active"\)/);
  const calendly = fs.readFileSync(path.join(__dirname, "calendly-theme.css"), "utf8");
  assert.match(calendly, /body\.client-ui\.auth-active #appShell/);
  assert.match(calendly, /body\.client-ui\.landing-active #appShell\[hidden\]/);
  assert.match(calendly, /body\.client-ui #themeToggle\s*\{\s*display:none/);
});
