#!/usr/bin/env node
/**
 * Build the two release artifacts.
 *
 * byoa's source is TypeScript, and Node refuses to strip types for files inside
 * node_modules - so a tarball of the source is not installable. Releases therefore ship a
 * bundled JavaScript build:
 *
 *   dist/byoa-<version>-linux-x64.tar.gz   standalone: ./byoa, no install
 *   dist/byoa-<version>-npm.tgz            npm-installable: npm i -g <file>
 *
 * Usage: node scripts/pack-release.mjs
 */
import { execFileSync } from "node:child_process"
import { chmodSync, copyFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const root = process.cwd()
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
const version = pkg.version

const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: "inherit" })

const copyDirSync = (from, to) => {
  rmSync(to, { recursive: true, force: true })
  cpSync(from, to, { recursive: true })
}

// 1. Bundle.
run("npx", [
  "esbuild",
  "bin/byoa.ts",
  "--bundle",
  "--platform=node",
  "--format=esm",
  "--target=node26",
  "--external:@opentui/core",
  "--outfile=dist/byoa.js",
])

// 2. Standalone tarball. The TUI is an optional dependency, not bundled, so the artifact carries
//    its node_modules next to the launcher; otherwise `--tui` silently falls back to the CLI.
rmSync(join(root, "dist/release"), { recursive: true, force: true })
rmSync(join(root, "dist/npm"), { recursive: true, force: true })
rmSync(join(root, "dist/stage"), { recursive: true, force: true })
mkdirSync(join(root, "dist/release"), { recursive: true })
mkdirSync(join(root, "dist/npm"), { recursive: true })
mkdirSync(join(root, "dist/stage"), { recursive: true })

const optional = pkg.optionalDependencies ?? {}
writeFileSync(
  join(root, "dist/stage/package.json"),
  `${JSON.stringify({ name: "byoa-stage", version, private: true, optionalDependencies: optional }, null, 2)}\n`,
)
if (Object.keys(optional).length > 0) {
  run("npm", ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], join(root, "dist/stage"))
  copyDirSync(join(root, "dist/stage/node_modules"), join(root, "dist/release/node_modules"))
}

copyFileSync(join(root, "dist/byoa.js"), join(root, "dist/release/byoa"))
chmodSync(join(root, "dist/release/byoa"), 0o755)
for (const file of ["LICENSE", "README.md", "CHANGELOG.md"]) {
  copyFileSync(join(root, file), join(root, "dist/release", file))
}
const hasOptional = Object.keys(optional).length > 0
const artifactFiles = ["byoa", ...(hasOptional ? ["node_modules"] : []), "LICENSE", "README.md", "CHANGELOG.md"]
run("tar", ["-czf", join(root, `dist/byoa-${version}-linux-x64.tar.gz`), ...artifactFiles], join(root, "dist/release"))

// 3. npm-installable package.
copyFileSync(join(root, "dist/byoa.js"), join(root, "dist/npm/byoa"))
chmodSync(join(root, "dist/npm/byoa"), 0o755)
for (const file of ["LICENSE", "README.md"]) copyFileSync(join(root, file), join(root, "dist/npm", file))
writeFileSync(
  join(root, "dist/npm/package.json"),
  `${JSON.stringify(
    {
      name: pkg.name,
      version,
      description: pkg.description,
      license: pkg.license,
      type: "module",
      bin: { byoa: "./byoa" },
      engines: { node: ">=26" },
      optionalDependencies: optional,
      files: ["byoa", "README.md", "LICENSE"],
    },
    null,
    2,
  )}\n`,
)
run("npm", ["pack", "--silent", "--pack-destination", join(root, "dist")], join(root, "dist/npm"))
// npm names it byoa-<version>.tgz; give it a distinct name so it cannot be confused with source.
rmSync(join(root, `dist/byoa-${version}-npm.tgz`), { force: true })
run("mv", [join(root, `dist/byoa-${version}.tgz`), join(root, `dist/byoa-${version}-npm.tgz`)], root)

console.log(`\nartifacts:\n  dist/byoa-${version}-linux-x64.tar.gz\n  dist/byoa-${version}-npm.tgz`)
