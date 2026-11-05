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

// Sum of chars for one month; yyyymm is e.g. "202610".
export function monthUsage(root, yyyymm) {
  const file = usageFile(root);
  if (!existsSync(file)) return 0;
  const prefix = `${yyyymm.slice(0, 4)}-${yyyymm.slice(4, 6)}`;
  let total = 0;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/).slice(1)) {
    const [date, , chars] = line.split('\t');
    if (date?.startsWith(prefix)) total += Number(chars) || 0;
  }
  return total;
}

export function budgetStatus(used, monthlyCharBudget) {
  return { ok: used < monthlyCharBudget, warn90: used >= monthlyCharBudget * 0.9 };
}
