import { readdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const srcDir = join(__dirname, "src");

function findTestFiles(dir: string): string[] {
  const results: string[] = [];
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...findTestFiles(full));
      } else if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".spec.ts")) {
        results.push(full);
      }
    }
  } catch {}
  return results;
}

const tests = findTestFiles(srcDir);

if (tests.length === 0) {
  console.log("No test files found. Skipping.");
  process.exit(0);
}

let passed = 0;
let failed = 0;

for (const testFile of tests) {
  try {
    await import(testFile);
    passed++;
    console.log(`PASS: ${testFile}`);
  } catch (err) {
    failed++;
    console.error(`FAIL: ${testFile}`);
    console.error(err);
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
