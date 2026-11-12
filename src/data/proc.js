// Preserve historical names by internal ID, without shipping old win rates.
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const names = {}
for (let i = 1; i <= 8; i ++) {
  const data = JSON.parse(readFileSync(join(__dirname, `${i}.json`), 'utf8'))
  for (const { enName, zhName } of data) {
    if (! enName || ! zhName) throw new Error(`Invalid legacy card in ${i}.json`)
    if (names[enName]) throw new Error(`Duplicate legacy card ID: ${enName}`)
    names[enName] = [zhName]
  }
}
console.log(JSON.stringify(Object.fromEntries(Object.entries(names).sort(([a], [b]) => a.localeCompare(b))), null, 2))
