#!/usr/bin/env node
// Path audit for docs/integrations/: every API path a guide mentions must be
// a route the server actually defines. Route truth is parsed straight from
// server/src/app.ts mounts + server/src/routes/*.ts handlers — the docs are
// checked against the code, not against a hand-maintained list.
//
// Usage: node scripts/check-integrations-docs.mjs   (exit 0 = all paths real)

import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const routesDir = path.join(root, 'server/src/routes')
const appFile = path.join(root, 'server/src/app.ts')
const docsDir = path.join(root, 'docs/integrations')

// --- 1. Server-side route truth ---------------------------------------------
// Per-router paths: `xxxRouter.get('/models'` plus the Gemini-style regex
// routes `xxxRouter.post(/^\/models\/(.+):generateContent$/`.
const routeFiles = (await readdir(routesDir)).filter(f => f.endsWith('.ts'))
const routerPaths = new Map() // 'proxyRouter' -> Set of '/models', ...
for (const file of routeFiles) {
  const src = await readFile(path.join(routesDir, file), 'utf8')
  for (const m of src.matchAll(
    /([A-Za-z]+Router)\.(get|post|put|delete|all)\(\s*(?:'([^']*)'|"([^"]*)"|\/\^(.+)\$\/)/g,
  )) {
    const name = m[1]
    // A regex route ^\/models\/(.+):generateContent$ → '/models/*:generateContent'
    const p = m[5]
      ? `/${m[5].replace(/\\\//g, '/').replace(/\(\.\+\)/g, '*')}`
      : (m[3] ?? m[4])
    if (!p) continue
    if (!routerPaths.has(name)) routerPaths.set(name, new Set())
    routerPaths.get(name).add(p)
  }
}
console.log(`Parsed ${routerPaths.size} routers from server/src/routes/*.ts`)

// Mounts: `app.use('/v1', proxyRouter)` — a router mounted with no prefix
// (e.g. `app.use(ollamaRouter)`) hangs at the root.
const appSrc = await readFile(appFile, 'utf8')
const mounts = []
for (const m of appSrc.matchAll(
  /app\.use\(\s*(?:'([^']*)'|"([^"]*)")?\s*,?\s*([A-Za-z]+Router)\)/g,
)) {
  mounts.push({ prefix: m[1] ?? m[2] ?? '', router: m[3] })
}

// Effective paths: prefix + each route path. Express `:param` and the `*`
// from regex routes match any single path-segment value.
const effective = []
for (const { prefix, router } of mounts) {
  for (const p of routerPaths.get(router) ?? []) effective.push(`${prefix}${p}`)
}
// URL-token wrapper: urlTokenRouter re-mounts proxy/responses/ollama under
// /v1/t/:token (server/src/app.ts:294-295 + server/src/routes/url-tokens.ts).
for (const inner of ['proxyRouter', 'responsesRouter', 'ollamaRouter']) {
  for (const p of routerPaths.get(inner) ?? []) effective.push(`/v1/t/*${p}`)
}

const toMatcher = routePath =>
  routePath.split('/').filter(Boolean).map(s => {
    if (s.startsWith(':')) return { wild: true, pre: '', post: '' }
    const star = s.indexOf('*')
    if (star === -1) return { wild: false, lit: s }
    return { wild: true, pre: s.slice(0, star), post: s.slice(star + 1) }
  })
const routeMatchers = effective.map(p => ({ p, segs: toMatcher(p) }))
function matchesRoute(docPath) {
  const docSegs = docPath.split('/').filter(Boolean)
  // Prose shorthand, not an endpoint claim: a bare base URL ("/v1") only has
  // to be a real mount prefix, and a trailing "/*" ("/v1/*") only claims the
  // surface exists.
  const prefixOnly = docSegs.length === 1 || docSegs[docSegs.length - 1] === '*'
  return routeMatchers.some(({ segs }) => {
    if (prefixOnly) {
      const n = docSegs[docSegs.length - 1] === '*' ? docSegs.length - 1 : docSegs.length
      return segs.length >= n && segs.slice(0, n).every((s, i) => s.wild || s.lit === docSegs[i])
    }
    return segs.length === docSegs.length
      && segs.every((s, i) =>
        s.wild
          ? docSegs[i].startsWith(s.pre) && docSegs[i].endsWith(s.post)
          : s.lit === docSegs[i],
      )
  })
}

// --- 2. Doc paths -------------------------------------------------------------
// Placeholder ids in prose (<token>, {model}) become `*` so they match the
// same way route params do. Then pull every `/v1…`, `/v1beta…`, `/api/…`,
// `/mcp…`, `/livez`, `/readyz` token out of the markdown.
const docs = (await readdir(docsDir)).filter(f => f.endsWith('.md')).sort()
const failures = []
const seen = []
for (const file of docs) {
  const raw = await readFile(path.join(docsDir, file), 'utf8')
  const text = raw.replace(/<(?:token|model|name|chain)>|\{(?:model|name|chain)\}/g, '*')
  const found = new Set()
  for (const m of text.matchAll(/\/(?:v1|v1beta|api\/[a-z]+|mcp|livez|readyz)(?:\/[\w:.*-]+)*/g)) {
    found.add(m[0].replace(/\/+$/, ''))
  }
  for (const p of found) {
    seen.push(`${file}: ${p}`)
    if (!matchesRoute(p)) failures.push(`${file}: ${p}`)
  }
}

// --- 3. Report -----------------------------------------------------------------
console.log(`Doc paths checked: ${seen.length} (across ${docs.length} files)`)
if (failures.length) {
  console.error(`\nFAIL — ${failures.length} doc path(s) not defined in server routes:`)
  for (const f of failures) console.error(`  ${f}`)
  process.exit(1)
}
console.log('PASS — every documented path matches a server route.')
