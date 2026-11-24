/**
 * The ONE next item of a lap, chosen in code before the pick step reads anything.
 *
 * An approved release's tickets carry the label `priority`. This reads the board the way the launch gate does
 * (`workable.ts`, `.shared/workable.ts`) and names, in a fixed order, the item the lap must work: a pull request of a
 * priority ticket, else the lowest open priority ticket. When there is none, the text is empty and the pick step's own
 * rules choose, as before. The pick step may refuse the item only with a recorded reason (loop-pick.md, "The next item").
 *
 * Output: `{ item, target, pr, why }`, every field text, empty when there is nothing to hand over.
 */

import { expiryHours } from '../../.shared/claims.ts';
import { emit, trimmed } from '../../.shared/io.ts';
import { workability, type BoardItem } from '../../.shared/workable.ts';

function gh(args: string[]): unknown {
  const result = Bun.spawnSync(['gh', ...args], { stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) {
    throw new Error(`gh ${args.slice(0, 2).join(' ')} failed (exit ${result.exitCode}): ${result.stderr.toString().trim()}`);
  }
  return JSON.parse(result.stdout.toString());
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function items(raw: unknown): BoardItem[] {
  if (!Array.isArray(raw)) throw new Error('gh returned no list');
  return raw.map((row: Record<string, unknown>) => ({
    number: Number(row.number),
    title: str(row.title),
    body: str(row.body),
    labels: Array.isArray(row.labels) ? row.labels.map((label: { name?: unknown }) => str(label.name)) : [],
    comments: Array.isArray(row.comments)
      ? row.comments.map((comment: { body?: unknown; createdAt?: unknown; url?: unknown }) => ({
          body: str(comment.body),
          createdAt: str(comment.createdAt),
          url: str(comment.url),
        }))
      : [],
  }));
}

const fields = 'number,title,body,labels,comments';
const board = {
  issues: items(gh(['issue', 'list', '--state', 'open', '--limit', '200', '--json', fields])),
  pulls: items(gh(['pr', 'list', '--state', 'open', '--limit', '100', '--json', fields])),
};
const found = workability(board, expiryHours(trimmed(process.env.INPUTS_CLAIM_HOURS)), Date.now());
const next = found.next;
if (next === null) {
  emit({ item: '', target: '', pr: '', why: '' });
} else {
  const repo = str((gh(['repo', 'view', '--json', 'url']) as { url?: unknown }).url).replace(/\/+$/, '');
  const issueUrl = (n: number): string => `${repo}/issues/${n}`;
  if (next.kind === 'pull') {
    emit({
      item: `pull request #${next.number}`,
      target: next.issue === undefined ? `${repo}/pull/${next.number}` : issueUrl(next.issue),
      pr: `${repo}/pull/${next.number}`,
      why: next.why,
    });
  } else {
    emit({ item: `issue #${next.number}`, target: issueUrl(next.number), pr: '', why: next.why });
  }
}
