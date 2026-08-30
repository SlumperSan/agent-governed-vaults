export const meta = {
  name: 'adversarial-review',
  description: 'Find bugs across target files, then adversarially refute each finding before reporting it',
  whenToUse:
    'Security or correctness review of a specific change or subsystem. This is the pattern that found the ' +
    'permanent-brick bug (PR #70) and the three deploy footguns (PR #69). Pass target files via args.',
  phases: [
    { title: 'Find', detail: 'one finder per target file, each with its own lens' },
    { title: 'Refute', detail: 'independent skeptics per finding, prompted to kill it' },
    { title: 'Synthesize', detail: 'rank survivors and name what was NOT covered' },
  ],
};

/*
 * WHY THIS SHAPE.
 *
 * A finder pool alone produces plausible-but-wrong findings at a high rate, and every one of those
 * costs a human reviewer real time. The refute stage exists to make a finding EARN its place: each
 * survivor has been attacked by independent skeptics who were told that killing it is the win.
 *
 * The verifiers use DIFFERENT LENSES rather than being N copies of one skeptic. A wrong finding
 * usually fails in one specific way -- it misreads the code, or it is real but unreachable, or it is
 * already mitigated elsewhere -- and identical verifiers share blind spots. Diversity catches what
 * redundancy cannot.
 *
 * Findings verify as soon as their finder returns (pipeline, not parallel): file A's findings are
 * being refuted while file B is still being read. A barrier here would waste the fast finders'
 * time for no benefit, because refutation needs only ONE finding, never the whole set.
 */

// ---------------------------------------------------------------- args

const raw = args ?? {};
const targets = (Array.isArray(raw) ? raw : (raw.targets ?? [])).map((t) =>
  typeof t === 'string' ? { file: t, lens: 'correctness, security, and unstated assumptions' } : t,
);

if (!targets.length) {
  throw new Error(
    'adversarial-review needs targets. Pass args as ["path/a.sol","path/b.sol"] or ' +
      '{targets:[{file,lens}], verifiers, context, maxTargets, maxFindings}.',
  );
}

const VERIFIERS = raw.verifiers ?? 2;
const CONTEXT = raw.context ?? '';
// Caps keep one invocation inside the session's agent budget. They are LOGGED, never silent:
// a truncated review that reads as "we covered everything" is worse than no review.
const MAX_TARGETS = raw.maxTargets ?? 5;
const MAX_FINDINGS = raw.maxFindings ?? 6;

const FINDINGS_SCHEMA = {
  type: 'object',
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['title', 'severity', 'location', 'claim', 'exploit'],
        properties: {
          title: { type: 'string' },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'info'] },
          location: { type: 'string', description: 'file:line' },
          claim: { type: 'string', description: 'the defect, stated so it can be checked' },
          exploit: { type: 'string', description: 'concrete inputs/state -> wrong outcome' },
        },
      },
    },
  },
};

const VERDICT_SCHEMA = {
  type: 'object',
  required: ['refuted', 'reason', 'confidence'],
  properties: {
    refuted: { type: 'boolean' },
    reason: { type: 'string' },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
  },
};

// Each lens attacks a finding from a different direction. Order matters only for readability.
const LENSES = [
  {
    key: 'misread',
    ask: 'Did the finder MISREAD the code? Re-read the cited lines and the functions they call. Does the code actually do what the claim says?',
  },
  {
    key: 'reachable',
    ask: 'Is this REACHABLE? Find a caller and a concrete state where it fires. Access control, a require earlier in the path, or an impossible precondition all kill it.',
  },
  {
    key: 'mitigated',
    ask: 'Is this ALREADY MITIGATED elsewhere -- a check in the caller, a factory-level guard, an invariant, or an existing test that would fail if this were real?',
  },
];

// ---------------------------------------------------------------- run

const used = targets.slice(0, MAX_TARGETS);
if (targets.length > used.length) {
  log(`CAP: reviewing ${used.length} of ${targets.length} targets. NOT covered: ${targets.slice(MAX_TARGETS).map((t) => t.file).join(', ')}`);
}

phase('Find');
log(`${used.length} finders over: ${used.map((t) => t.file).join(', ')}`);

const perTarget = await pipeline(
  used,
  // Stage 1 -- read the file and report defects.
  (t) =>
    agent(
      `Review ${t.file} in this repository for defects, with particular attention to: ${t.lens}.
${CONTEXT ? `\nExtra context for this review:\n${CONTEXT}\n` : ''}
Read the file AND the code it calls into -- a claim about behaviour you did not read is a guess.
Report only concrete, code-grounded defects. Precision over volume: a wrong finding costs a human
reviewer more than a missed low-severity one. An empty findings array is a perfectly good answer
for sound code.`,
      { label: `find:${t.file.split('/').pop()}`, phase: 'Find', schema: FINDINGS_SCHEMA },
    ),

  // Stage 2 -- refute each of THIS target's findings immediately, without waiting for other targets.
  (found, t) => {
    const list = (found?.findings ?? []).slice(0, MAX_FINDINGS);
    if ((found?.findings ?? []).length > list.length) {
      log(`CAP: ${t.file} returned ${found.findings.length} findings; verifying the first ${list.length}.`);
    }
    if (!list.length) return [];

    return parallel(
      list.map((f) => () =>
        parallel(
          LENSES.slice(0, VERIFIERS).map((lens) => () =>
            agent(
              `Your job is to REFUTE this claimed defect in ${t.file}. Killing it is the win.

  Title:    ${f.title}
  Location: ${f.location}
  Claim:    ${f.claim}
  Exploit:  ${f.exploit}

Attack it specifically on this axis: ${lens.ask}

Read the actual code before answering. If you cannot establish that the claim holds, set
refuted=true -- the burden of proof is on the finding, not on you.`,
              { label: `refute:${lens.key}`, phase: 'Refute', schema: VERDICT_SCHEMA },
            ),
          ),
        ).then((votes) => {
          const cast = votes.filter(Boolean);
          const kills = cast.filter((v) => v.refuted).length;
          // A finding survives only on a clear majority of NON-refutations. Ties and total
          // verifier failure both count against it: unverified is not the same as confirmed.
          const survives = cast.length > 0 && kills * 2 < cast.length;
          return { ...f, file: t.file, survives, votes: cast, kills, cast: cast.length };
        }),
      ),
    );
  },
);

const all = perTarget.flat().filter(Boolean);
const confirmed = all.filter((f) => f.survives);
const killed = all.filter((f) => !f.survives);

log(`${all.length} findings examined -> ${confirmed.length} survived refutation, ${killed.length} killed.`);

if (!confirmed.length) {
  return {
    confirmed: [],
    killed: killed.map((f) => ({ title: f.title, file: f.file, why: f.votes.find((v) => v.refuted)?.reason })),
    summary: 'No finding survived adversarial refutation.',
  };
}

phase('Synthesize');
const report = await agent(
  `Write a review report from these findings, all of which already survived independent refutation.

${JSON.stringify(confirmed.map(({ votes, ...f }) => f), null, 2)}

Rank by real-world risk: blast radius, reversibility, and how plausibly the triggering conditions
occur -- not by the label the finder attached. For each, give the defect, the concrete failure, and
the smallest fix that closes it.

Then add a short "not covered" section naming what this review did NOT examine: files outside
${JSON.stringify(used.map((t) => t.file))}, and any lens you think the findings above suggest is
missing. Do not pad it -- name real gaps only.`,
  { label: 'synthesize', phase: 'Synthesize' },
);

return {
  confirmed,
  killed: killed.map((f) => ({ title: f.title, file: f.file, why: f.votes.find((v) => v.refuted)?.reason })),
  report,
};
