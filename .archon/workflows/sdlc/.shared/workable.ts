/**
 * What a lap of the loop could start right now, read from the board without a model.
 *
 * A scheduler calls this before it starts a lap. A lap that finds nothing to do still
 * costs a pick, a worktree and a database run, and a backlog that is one long chain of
 * dependencies leaves most parallel laps with nothing. This mirrors the pick rules that
 * are facts rather than judgement: an item with a live claim is taken, an item labelled
 * `needs-owner` waits for the owner, a `found-list` issue waits for a release label, an issue waits for its `Depends on:` items, and the
 * issues the manager keeps for itself are not work. Anything it is unsure of counts as
 * workable, so the gate can only skip laps that would have picked nothing.
 */

import { CLAIM_PREFIX } from './claims.ts';

export interface BoardComment {
  readonly body: string;
  readonly createdAt: string;
  /** The comment's web URL; its `#issuecomment-<id>` names the comment to edit. */
  readonly url?: string;
}

export interface BoardItem {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly labels: readonly string[];
  readonly comments: readonly BoardComment[];
}

export interface Board {
  readonly issues: readonly BoardItem[];
  readonly pulls: readonly BoardItem[];
}

export interface WorkableItem {
  readonly kind: 'issue' | 'pull';
  readonly number: number;
}

export interface LiveClaim {
  readonly kind: 'issue' | 'pull';
  readonly number: number;
  readonly run: string;
}

export interface EndedClaim extends LiveClaim {
  readonly url: string;
}

/** The ONE item a lap works next, chosen in code (see `nextItem`), or null when the pick step's own rules decide. */
export interface NextItem {
  readonly kind: 'issue' | 'pull';
  readonly number: number;
  /** For a pull request: the issue it is the work for (the lowest one), when it names one. */
  readonly issue?: number;
  readonly why: string;
}

export interface Workability {
  /** The one next item: a priority pull request, else a priority issue, else null. */
  readonly next: NextItem | null;
  readonly workable: WorkableItem[];
  readonly claims: LiveClaim[];
  /** Claims whose run the scheduler knows has ended: dead now, and the caller releases them. */
  readonly ended: EndedClaim[];
  readonly waiting: { readonly kind: 'issue' | 'pull'; readonly number: number; readonly why: string }[];
}

/**
 * The label an approved release's tickets carry (the Forge files them with it), and the owner's "before everything else":
 * work under it goes first, so a release is never left waiting because the factory works on other things.
 */
export const PRIORITY_LABEL = 'priority';

/** The label an owner decision carries; the loop never works an item under it. */
export const OWNER_LABEL = 'needs-owner';

/** The label of a found list: one issue that collects what the loop found beyond its current job. */
export const FOUND_LIST_LABEL = 'found-list';

/**
 * A release label as a release planner writes it: a version such as `0.1.0`, `v2.3` or `beta.31`.
 * A found list is work only once a release has taken it in, which puts such a label on it.
 */
export const RELEASE_LABEL = /^(?:v?\d+\.\d+(?:\.\d+)?(?:[.-][0-9a-z.]+)?|(?:alpha|beta|rc)[.-]?\d+(?:\.\d+)*)$/i;

/** A found list no release has taken in: not work, and neither is a pull request for it. */
export const heldFoundList = (labels: readonly string[]): boolean =>
  labels.includes(FOUND_LIST_LABEL) && !labels.some(l => RELEASE_LABEL.test(l));

/** Issues the manager keeps for its own records. They hold questions and metrics, not work. */
export const MANAGER_TITLES = new Set(['Owner decisions needed', 'Loop metrics']);

/** `Depends on: #12, #14` lines, as pick reads them. */
export function dependencies(body: string): number[] {
  const found: number[] = [];
  for (const line of body.split(/\r?\n/)) {
    const match = /^\s*[-*]?\s*\**depends on\**:?\**\s*(.*)$/i.exec(line);
    if (match === null) continue;
    for (const ref of match[1].matchAll(/#(\d+)/g)) found.push(Number(ref[1]));
  }
  return found;
}

/** Issues a pull request says it delivers (`Closes #n`, `Fixes #n`, `Resolves #n`). */
export function closes(body: string): number[] {
  return [...body.matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/gi)].map(m => Number(m[1]));
}

/**
 * Issues a pull request is the work for: the ones it closes, and the ones it only references
 * (`Refs #n`, `Relates to #n`). A delivery links its issue with `Refs` until its final review
 * adds the closing keyword, and while it does, a lap holding the issue holds the pull request too.
 */
export function references(body: string): number[] {
  const refs = [...body.matchAll(/\b(?:refs?|relates? to|references?)\s+#(\d+)/gi)].map(m => Number(m[1]));
  return [...new Set([...closes(body), ...refs])];
}

/** Unexpired claim comments on an item, oldest first, with the run each names. */
export function liveClaimComments(
  comments: readonly BoardComment[],
  expiryHours: number,
  now: number
): { run: string; comment: BoardComment }[] {
  const found: { run: string; comment: BoardComment }[] = [];
  for (const comment of comments) {
    if (!comment.body.startsWith(CLAIM_PREFIX)) continue;
    const created = Date.parse(comment.createdAt);
    if (Number.isNaN(created) || now - created > expiryHours * 3_600_000) continue;
    found.push({ run: comment.body.slice(CLAIM_PREFIX.length).split(/\s/, 1)[0] ?? '', comment });
  }
  return found;
}

/**
 * The ONE next item, decided in code and handed to the lap's pick step as an input, in a fixed order:
 *   1. a workable pull request that is the work for a `priority` issue (or is itself labelled `priority`), lowest issue first;
 *   2. a workable `priority` issue, lowest number first;
 *   3. nothing: the pick step's own rules decide, for everything else.
 * `workable` is what `workability` found workable: an item with a live claim, under `needs-owner`, waiting on an open
 * dependency (a closed one is no reason to wait) or already delivered by a pull request is not in it.
 */
export function nextItem(board: Board, workable: readonly WorkableItem[]): NextItem | null {
  const labelsOfIssue = (n: number): readonly string[] => board.issues.find(i => i.number === n)?.labels ?? [];
  const pulls: { number: number; issue: number | undefined; order: number }[] = [];
  for (const w of workable) {
    if (w.kind !== 'pull') continue;
    const pull = board.pulls.find(p => p.number === w.number);
    if (pull === undefined) continue;
    const linked = references(pull.body).filter(n => board.issues.some(i => i.number === n));
    const prioritised = linked.filter(n => labelsOfIssue(n).includes(PRIORITY_LABEL));
    if (!pull.labels.includes(PRIORITY_LABEL) && prioritised.length === 0) continue;
    const issue = (prioritised.length > 0 ? prioritised : linked).sort((a, b) => a - b)[0];
    pulls.push({ number: pull.number, issue, order: issue ?? pull.number });
  }
  if (pulls.length > 0) {
    const first = pulls.sort((a, b) => a.order - b.order || a.number - b.number)[0];
    return {
      kind: 'pull',
      number: first.number,
      ...(first.issue === undefined ? {} : { issue: first.issue }),
      why: `a pull request of a priority ticket${first.issue === undefined ? '' : ` (#${first.issue})`} that needs continuing comes before everything else`,
    };
  }
  const issues = workable
    .filter(w => w.kind === 'issue' && labelsOfIssue(w.number).includes(PRIORITY_LABEL))
    .map(w => w.number)
    .sort((a, b) => a - b);
  if (issues.length > 0) {
    return { kind: 'issue', number: issues[0], why: `the lowest open priority ticket (#${issues[0]}) comes before everything else` };
  }
  return null;
}

/**
 * The board as a lap would find it. `endedRuns` are runs the scheduler knows have
 * finished, failed or been cancelled: a run killed before its release step never frees
 * its item, so its claim is treated as dead here and returned in `ended` for release.
 */
export function workability(
  board: Board,
  expiryHours: number,
  now = Date.now(),
  endedRuns: ReadonlySet<string> = new Set()
): Workability {
  const openIssues = new Set(board.issues.map(item => item.number));
  const openPulls = new Set(board.pulls.map(item => item.number));
  const claims: LiveClaim[] = [];
  const ended: EndedClaim[] = [];
  const claimed = new Map<string, string>();
  for (const [kind, items] of [
    ['issue', board.issues],
    ['pull', board.pulls],
  ] as const) {
    for (const item of items) {
      for (const { run, comment } of liveClaimComments(item.comments, expiryHours, now)) {
        if (endedRuns.has(run)) {
          if (comment.url) ended.push({ kind, number: item.number, run, url: comment.url });
          continue;
        }
        if (claimed.has(`${kind}:${item.number}`)) continue;
        claims.push({ kind, number: item.number, run });
        claimed.set(`${kind}:${item.number}`, run);
      }
    }
  }
  // An open pull request is the work for the issues it closes or references: pick continues the
  // pull request instead of starting the issue, and claims the issue for it.
  const deliveredBy = new Map<number, number>();
  for (const pull of board.pulls) for (const issue of references(pull.body)) deliveredBy.set(issue, pull.number);

  const workable: WorkableItem[] = [];
  const waiting: Workability['waiting'] = [];
  for (const pull of board.pulls) {
    const linked = references(pull.body).filter(n => openIssues.has(n));
    const owner = pull.labels.includes(OWNER_LABEL) ||
      linked.some(n => {
        const labels = board.issues.find(i => i.number === n)?.labels ?? [];
        return labels.includes(OWNER_LABEL) || heldFoundList(labels);
      });
    const holder = claimed.get(`pull:${pull.number}`) ?? linked.map(n => claimed.get(`issue:${n}`)).find(Boolean);
    if (owner) waiting.push({ kind: 'pull', number: pull.number, why: OWNER_LABEL });
    else if (holder) waiting.push({ kind: 'pull', number: pull.number, why: `claimed by run ${holder}` });
    else workable.push({ kind: 'pull', number: pull.number });
  }
  for (const issue of board.issues) {
    const blockers = dependencies(issue.body).filter(n => openIssues.has(n) || openPulls.has(n));
    const holder = claimed.get(`issue:${issue.number}`);
    let why: string | null = null;
    if (MANAGER_TITLES.has(issue.title.trim())) why = "the manager's own record";
    else if (issue.labels.includes(OWNER_LABEL)) why = OWNER_LABEL;
    else if (heldFoundList(issue.labels)) {
      why = 'a found list no release has taken in';
    }
    else if (deliveredBy.has(issue.number)) why = `delivered by pull request #${deliveredBy.get(issue.number)}`;
    else if (holder) why = `claimed by run ${holder}`;
    else if (blockers.length > 0) why = `depends on ${blockers.map(n => `#${n}`).join(', ')}`;
    if (why === null) workable.push({ kind: 'issue', number: issue.number });
    else waiting.push({ kind: 'issue', number: issue.number, why });
  }
  return { next: nextItem(board, workable), workable, claims, ended, waiting };
}
