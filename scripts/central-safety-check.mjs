import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
function check(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Unexpected central source symlink');
    if (entry.isDirectory()) check(file);
    else if (/\.(ts|js|sql)$/.test(file) && /\b(?:DELETE\s+FROM|TRUNCATE(?:\s+TABLE)?)\b/i.test(readFileSync(file, 'utf8'))) {
      throw new Error(`Physical business deletion is prohibited in ${file}`);
    }
  }
}
check('src/central');
console.log('Central production deletion guard passed.');
