import { describe, expect, it } from 'bun:test';
import {
  closes,
  references,
  dependencies,
  workability,
  type BoardItem,
} from '../../workflows/sdlc/.shared/workable';

const now = Date.parse('2026-10-17T12:00:00Z');
const hoursAgo = (h: number): string => new Date(now - h * 3_600_000).toISOString();

function item(number: number, extra: Partial<BoardItem> = {}): BoardItem {
  return { number, title: `item ${number}`, body: '', labels: [], comments: [], ...extra };
}

const claim = (run: string, h = 1): BoardItem['comments'][number] => ({
  body: `Loop claim: run ${run}\n\nRoute: simple\nArea: a`,
  createdAt: hoursAgo(h),
});

describe('loop launch gate', () => {
  it('a found list is not work until a release label is on it', () => {
    const result = workability(
      {
        issues: [
          item(1, { labels: ['bug', 'found-list'] }),
          item(2, { labels: ['bug', 'found-list', 'beta.31'] }),
          item(3, { labels: ['found-list', '0.1.0'] }),
          item(4, { labels: ['bug', 'found-list', 'needs-owner', 'beta.31'] }),
        ],
        pulls: [],
      },
      6,
      now
    );
    expect(result.workable).toEqual([
      { kind: 'issue', number: 2 },
      { kind: 'issue', number: 3 },
    ]);
    expect(result.waiting.find(w => w.number === 1)?.why).toBe('a found list no release has taken in');
    expect(result.waiting.find(w => w.number === 4)?.why).toBe('needs-owner');
  });

  it('a pull request for a found list no release has taken in is not work either', () => {
    const result = workability(
      {
        issues: [item(1, { labels: ['found-list'] }), item(2, { labels: ['found-list', '0.1.0'] })],
        pulls: [item(10, { body: 'Closes #1' }), item(11, { body: 'Closes #2' })],
      },
      6,
      now
    );
    expect(result.workable.filter(w => w.kind === 'pull')).toEqual([{ kind: 'pull', number: 11 }]);
    expect(result.waiting.find(w => w.kind === 'pull' && w.number === 10)?.why).toBe('needs-owner');
  });

  it('reads Depends on lines and closing keywords the way pick does', () => {
    expect(dependencies('Intro\nDepends on: #3, #5\n- **Depends on:** #9')).toEqual([3, 5, 9]);
    expect(dependencies('This depends on nothing; see #4')).toEqual([]);
    expect(closes('Closes #12. Also fixes #13 and Resolves #14')).toEqual([12, 13, 14]);
  });

  it('an open issue with no claim, owner label or open dependency is workable', () => {
    const result = workability({ issues: [item(1), item(2, { body: 'Depends on: #9' })], pulls: [] }, 6, now);
    // #9 is not open, so it is closed: #2 is free too.
    expect(result.workable).toEqual([
      { kind: 'issue', number: 1 },
      { kind: 'issue', number: 2 },
    ]);
  });

  it('a serial chain leaves only its head workable', () => {
    const result = workability(
      {
        issues: [item(1), item(2, { body: 'Depends on: #1' }), item(3, { body: 'Depends on: #2' })],
        pulls: [],
      },
      6,
      now
    );
    expect(result.workable).toEqual([{ kind: 'issue', number: 1 }]);
    expect(result.waiting.map(w => w.why)).toEqual(['depends on #1', 'depends on #2']);
  });

  it('live claims take items; released, withdrawn and expired claims do not', () => {
    const result = workability(
      {
        issues: [
          item(1, { comments: [claim('run-a')] }),
          item(2, { comments: [{ body: 'Loop claim released: run run-b ended.', createdAt: hoursAgo(1) }] }),
          item(3, { comments: [{ body: 'Loop claim withdrawn: run run-c', createdAt: hoursAgo(1) }] }),
          item(4, { comments: [claim('run-d', 7)] }),
        ],
        pulls: [],
      },
      6,
      now
    );
    expect(result.claims).toEqual([{ kind: 'issue', number: 1, run: 'run-a' }]);
    expect(result.workable.map(w => w.number)).toEqual([2, 3, 4]);
  });

  it('a claim held by a run the scheduler knows has ended is dead and returned for release', () => {
    const dead = { ...claim('run-gone'), url: 'https://github.com/o/r/issues/1#issuecomment-77' };
    const result = workability(
      { issues: [item(1, { comments: [dead, claim('run-live')] })], pulls: [] },
      6,
      now,
      new Set(['run-gone'])
    );
    // The next live claim holds the item; the dead one is released, not counted.
    expect(result.claims).toEqual([{ kind: 'issue', number: 1, run: 'run-live' }]);
    expect(result.ended).toEqual([{ kind: 'issue', number: 1, run: 'run-gone', url: dead.url }]);
    expect(result.workable).toEqual([]);

    const alone = workability({ issues: [item(2, { comments: [dead] })], pulls: [] }, 6, now, new Set(['run-gone']));
    expect(alone.workable).toEqual([{ kind: 'issue', number: 2 }]);
  });

  it("owner decisions and the manager's records are not work", () => {
    const result = workability(
      {
        issues: [
          item(1, { labels: ['needs-owner'] }),
          item(2, { title: 'Owner decisions needed' }),
          item(3, { title: 'Loop metrics' }),
        ],
        pulls: [],
      },
      6,
      now
    );
    expect(result.workable).toEqual([]);
  });

  it('an open pull request is the work for the issue it closes, and shares its claim', () => {
    const free = workability({ issues: [item(1)], pulls: [item(20, { body: 'Closes #1' })] }, 6, now);
    expect(free.workable).toEqual([{ kind: 'pull', number: 20 }]);

    const held = workability(
      { issues: [item(1, { comments: [claim('run-a')] })], pulls: [item(20, { body: 'Closes #1' })] },
      6,
      now
    );
    expect(held.workable).toEqual([]);

    const parked = workability(
      { issues: [item(1, { labels: ['needs-owner'] })], pulls: [item(20, { body: 'Closes #1' })] },
      6,
      now
    );
    expect(parked.workable).toEqual([]);
  });

  it('a pull request that only references its issue (Refs #n, until its final review) shares the claim too', () => {
    expect(references('Refs #1. Relates to #2; see also #3')).toEqual([1, 2]);
    const held = workability(
      { issues: [item(1, { comments: [claim('run-a')] })], pulls: [item(28, { body: 'Refs #1' })] },
      6,
      now
    );
    expect(held.workable).toEqual([]);
    const free = workability({ issues: [item(1)], pulls: [item(28, { body: 'Refs #1' })] }, 6, now);
    expect(free.workable).toEqual([{ kind: 'pull', number: 28 }]);
  });
});

describe('the one next item, chosen in code', () => {
  const tickets = (n: number): BoardItem => item(n, { labels: ['bug', 'priority', 'beta.32'] });
  it("an approved release's open ticket comes before every other item, lowest number first", () => {
    const result = workability({ issues: [item(5), tickets(616), item(1), tickets(609)], pulls: [] }, 6, now);
    expect(result.next).toMatchObject({ kind: 'issue', number: 609 });
  });
  it('a pull request of a priority ticket comes before starting a priority ticket and before any other pull request', () => {
    const result = workability(
      {
        issues: [item(2), tickets(609), tickets(616)],
        pulls: [item(11, { body: 'Closes #2', headRef: 'archon/two' }), item(12, { body: 'Refs #616', headRef: 'archon/616' })],
      },
      6,
      now
    );
    expect(result.next).toMatchObject({ kind: 'pull', number: 12, issue: 616 });
  });
  it('a claimed, parked or waiting ticket is not handed over; a closed dependency is no reason to wait', () => {
    const result = workability(
      {
        issues: [
          tickets(609),
          { ...tickets(610), comments: [claim('r1')] },
          item(611, { labels: ['priority', 'needs-owner'] }),
          { ...tickets(612), body: 'Depends on: #700' },
          { ...tickets(613), body: 'Depends on: #670' },
          item(700),
        ],
        pulls: [],
      },
      6,
      now
    );
    expect(result.next).toMatchObject({ kind: 'issue', number: 609 });
    const without = workability({ issues: [{ ...tickets(610), comments: [claim('r1')] }, { ...tickets(613), body: 'Depends on: #670' }], pulls: [] }, 6, now);
    expect(without.next).toMatchObject({ kind: 'issue', number: 613 }); // #670 is not open: nothing to wait for
  });
  it('with no priority ticket nothing is handed over and the pick step decides', () => {
    expect(workability({ issues: [item(1), item(2)], pulls: [item(3, { body: 'Closes #1' })] }, 6, now).next).toBeNull();
  });
  it('a pull request this loop does not own, or one of a ticket that is not priority, is never handed over', () => {
    const result = workability(
      {
        issues: [item(2), tickets(609), tickets(616)],
        pulls: [
          item(10, { body: 'Refs #609', headRef: 'someone/else' }), // a contributor's: not this loop's
          item(11, { body: 'Closes #2', headRef: 'archon/two', labels: ['priority'] }), // its own label proves nothing
        ],
      },
      6,
      now
    );
    // #609 is the contributor's pull request's work (the gate's own rule), so the next item is the one behind it
    expect(result.next).toMatchObject({ kind: 'issue', number: 616 });
  });
  it('an item the pick step refused in the last hour is left out, so one refusal never starves the tickets behind it', () => {
    const refusal = { body: 'Loop refused: a dependency is still open', createdAt: hoursAgo(0.5) };
    const result = workability({ issues: [{ ...tickets(609), comments: [refusal] }, tickets(616)], pulls: [] }, 6, now);
    expect(result.next).toMatchObject({ kind: 'issue', number: 616 });
    const old = workability({ issues: [{ ...tickets(609), comments: [{ ...refusal, createdAt: hoursAgo(3) }] }, tickets(616)], pulls: [] }, 6, now);
    expect(old.next).toMatchObject({ kind: 'issue', number: 609 });
  });
  it("a pull request that carries this loop's comments is its own, whatever its branch is called", () => {
    const review = { body: 'Loop review: sent back (route: simple)', createdAt: hoursAgo(2) };
    const result = workability({ issues: [tickets(616)], pulls: [item(12, { body: 'Refs #616', headRef: 'fix-616', comments: [review] })] }, 6, now);
    expect(result.next).toMatchObject({ kind: 'pull', number: 12, issue: 616 });
  });
});
