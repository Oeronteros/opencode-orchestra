import assert from "node:assert/strict"
import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { describe, it } from "node:test"
import { LOCALES, type LocaleCode } from "../dashboard/src/lib/locales.js"

const CYRILLIC = /[\u0400-\u04FF]/

/** Every dashboard source file except the locale catalogue itself. */
function dashboardSources(): string[] {
  const root = path.resolve("dashboard/src")
  const files: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry)
      if (statSync(full).isDirectory()) walk(full)
      else if (/\.tsx?$/.test(entry)) files.push(full)
    }
  }
  walk(root)
  return files.filter((file) => path.basename(file) !== "locales.ts")
}

/**
 * Plural categories a language actually uses for integer counts. Intl reports
 * categories the locale can produce at all (ru also has "other" for fractions),
 * so sampling integers keeps the requirement exact instead of over-strict.
 */
function integerPluralCategories(locale: LocaleCode): Set<string> {
  const rules = new Intl.PluralRules(locale)
  const used = new Set<string>()
  for (let count = 0; count <= 200; count += 1) used.add(rules.select(count))
  return used
}

function splitPlural(key: string): { base: string; category: string } | null {
  const match = /^(.+)_(zero|one|two|few|many|other)$/.exec(key)
  return match ? { base: match[1]!, category: match[2]! } : null
}

function pluralBases(keys: string[]): Set<string> {
  const bases = new Set<string>()
  for (const key of keys) {
    const parsed = splitPlural(key)
    if (parsed) bases.add(parsed.base)
  }
  return bases
}

function singularKeys(keys: string[]): string[] {
  return keys.filter((key) => splitPlural(key) === null).sort()
}

const codes = Object.keys(LOCALES) as LocaleCode[]

describe("locale catalogue", () => {
  it("ships both supported languages", () => {
    assert.deepEqual(codes.sort(), ["en", "ru"])
  })

  it("defines the same singular keys in every language", () => {
    const reference = singularKeys(Object.keys(LOCALES.ru))
    for (const code of codes) {
      assert.deepEqual(singularKeys(Object.keys(LOCALES[code])), reference, `locale ${code} key set differs`)
    }
  })

  it("defines the same plural families in every language", () => {
    const reference = [...pluralBases(Object.keys(LOCALES.ru))].sort()
    assert.ok(reference.length > 0, "expected at least one pluralised key")
    for (const code of codes) {
      assert.deepEqual([...pluralBases(Object.keys(LOCALES[code]))].sort(), reference, `locale ${code} plural families differ`)
    }
  })

  it("covers every plural category the language needs for integer counts", () => {
    for (const code of codes) {
      const keys = Object.keys(LOCALES[code])
      const required = integerPluralCategories(code)
      for (const base of pluralBases(keys)) {
        for (const category of required) {
          assert.ok(keys.includes(`${base}_${category}`), `locale ${code} misses ${base}_${category}`)
        }
      }
    }
  })

  it("has no empty translations", () => {
    for (const code of codes) {
      for (const [key, value] of Object.entries(LOCALES[code])) {
        assert.equal(typeof value, "string", `${code}.${key} must be a string`)
        assert.ok(value.trim().length > 0, `${code}.${key} is empty`)
      }
    }
  })

  it("keeps Russian copy out of the English catalogue", () => {
    for (const [key, value] of Object.entries(LOCALES.en)) {
      assert.ok(!CYRILLIC.test(value), `en.${key} still contains Cyrillic text`)
    }
  })
})

describe("dashboard localization coverage", () => {
  it("scans real dashboard sources", () => {
    const files = dashboardSources()
    assert.ok(files.length >= 5, `expected dashboard sources, found ${files.length}`)
    assert.ok(files.some((file) => file.endsWith("app.tsx")), "app.tsx must be scanned")
  })

  it("leaves no hardcoded Cyrillic strings in dashboard sources", () => {
    const offenders: string[] = []
    for (const file of dashboardSources()) {
      const lines = readFileSync(file, "utf8").split("\n")
      lines.forEach((line, index) => {
        if (CYRILLIC.test(line)) offenders.push(`${path.relative(process.cwd(), file)}:${index + 1}: ${line.trim()}`)
      })
    }
    assert.deepEqual(offenders, [], `hardcoded Russian copy must move into the locale catalogue:\n${offenders.join("\n")}`)
  })
})
