import { readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

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
    const { stdout, stderr } = await execAsync(`npx tsx "${testFile}"`);
    passed++;
    console.log(`PASS: ${testFile}`);
    if (stdout.trim()) console.log(stdout.trim());
  } catch (err: any) {
    failed++;
    console.error(`FAIL: ${testFile}`);
    if (err.stdout) console.error(err.stdout.trim());
    if (err.stderr) console.error(err.stderr.trim());
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
