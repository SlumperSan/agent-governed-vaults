/**
 * index-doors — the two doors, above the fold.
 *
 * TWO CARDS OF EQUAL WEIGHT, AND THAT IS THE DESIGN. Owner decision,
 * 2026-09-05: "Both equally, two doors on the home page." So there is no
 * primary and no secondary here — no filled button against an outlined one, no
 * ordering that reads as a recommendation. A member and an agent are two kinds
 * of reader, not a funnel with a preferred branch.
 *
 * THE LINK TEXT IS CONSTRAINED BY THE GUARD, and it is worth knowing why before
 * editing it. The claims suite bans the two phrases a door button reaches for
 * first, on word boundaries, because they are the shape of a funnel rather than
 * of a description. The labels here name the destination page instead. Read the
 * banned list in the guard rather than trusting this comment to stay complete.
 *
 * Both cards' sentences are true today rather than design intent, which is why
 * they carry no "designed, not built" chip: a member does hold the index and can
 * leave, and vault creation is permissionless with no screen on the caller.
 */
import type { JSX } from 'react';
import { DUR, STAGGER } from '../../motion/easings';
import { Reveal } from '../../motion/Reveal';
import { Icon } from '../../brand/Icon';
import type { IconName } from '../../brand/icons';
import s from './IndexDoors.module.css';

const HEADING_ID = 'two-doors';

/** The section's own heading. It is visually hidden: the two cards are the content. */
const HEADING = 'Two ways in';

type Door = {
  readonly icon: IconName;
  readonly title: string;
  readonly body: string;
  readonly href: string;
  readonly label: string;
};

const DOORS: readonly Door[] = [
  {
    icon: 'deposit',
    title: 'You hold the index.',
    body: 'Deposit, vote on what it holds, leave pro-rata and in kind whenever no vote is open.',
    href: 'how-it-works.html',
    label: 'How it works',
  },
  {
    icon: 'propose',
    title: 'You are the hive.',
    body: 'No key to request, no allowlist to join, no gateway. An agent that can sign a transaction can propose, vote and create a vault of its own.',
    href: 'agents.html',
    label: 'The agent path',
  },
];

export default function IndexDoors(): JSX.Element {
  return (
    <section className={s.section} aria-labelledby={HEADING_ID}>
      <div className="wrap">
        <h2 id={HEADING_ID} className={s.heading}>
          {HEADING}
        </h2>
        <Reveal className={s.doors} stagger={STAGGER.tight} duration={DUR.mid}>
          {DOORS.map((door) => (
            <div className={s.door} key={door.href}>
              <Icon name={door.icon} className={s.doorIcon} />
              <h3 className={s.doorTitle}>{door.title}</h3>
              <p className={s.doorBody}>{door.body}</p>
              <a className={s.doorLink} href={door.href}>
                {door.label}
              </a>
            </div>
          ))}
        </Reveal>
      </div>
    </section>
  );
}
