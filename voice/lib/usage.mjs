// Monthly usage ledger: <root>/data/voice-usage.tsv (date, operation, chars, seconds).
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

const HEADER = 'date\toperation\tchars\tseconds\n';
const usageFile = (root) => join(root, 'data', 'voice-usage.tsv');

export function appendUsage({ root, date, operation, chars = '', seconds = '' }) {
  const file = usageFile(root);
  mkdirSync(dirname(file), { recursive: true });
  if (!existsSync(file)) appendFileSync(file, HEADER);
  appendFileSync(file, `${date}\t${operation}\t${chars}\t${seconds}\n`);
}

// Sum of one numeric column (2 = chars, 3 = seconds) for a month; yyyymm is e.g. "202610".
function monthColumn(root, yyyymm, column) {
  const file = usageFile(root);
  if (!existsSync(file)) return 0;
  const prefix = `${yyyymm.slice(0, 4)}-${yyyymm.slice(4, 6)}`;
  let total = 0;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/).slice(1)) {
    const cells = line.split('\t');
    if (cells[0]?.startsWith(prefix)) total += Number(cells[column]) || 0;
  }
  return total;
}

// Sum of chars for one month.
export const monthUsage = (root, yyyymm) => monthColumn(root, yyyymm, 2);

// Sum of seconds of audio assessed in one month, to 0.1 s.
export const monthSeconds = (root, yyyymm) => Math.round(monthColumn(root, yyyymm, 3) * 10) / 10;

export function budgetStatus(used, monthlyCharBudget) {
  return { ok: used < monthlyCharBudget, warn90: used >= monthlyCharBudget * 0.9 };
}
