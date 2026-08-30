export const meta = {
  name: 'department-buildout',
  description: 'Author N independent charters/plans in parallel from one brief, then integrate them into a single plan',
  whenToUse:
    'Any "write the whole set at once" job where the pieces are independent but must end up consistent: ' +
    'department charters, per-vertical go-to-market plans, runbooks per subsystem, per-module threat models. ' +
    'This is the pattern that produced the 8 department charters + Company Plan.',
  phases: [
    { title: 'Author', detail: 'one agent per unit, working from the shared brief' },
    { title: 'Integrate', detail: 'reconcile conflicts and surface decisions the author pass could not make' },
  ],
};

/*
 * WHY THIS SHAPE.
 *
 * Writing N documents in one context makes them blur: later sections inherit the vocabulary and
 * assumptions of earlier ones, and the whole set converges on a single voice that agrees with
 * itself. Independent authors disagree, and the disagreements are the valuable output -- they are
 * exactly where an unstated assumption is hiding.
 *
 * So the integrate pass is NOT a summarizer. Its job is to find where the authors contradict each
 * other and to name the decisions that no author had standing to make. A synthesis that reports
 * "all units are aligned" has usually just flattened the signal.
 */

// ---------------------------------------------------------------- args

const raw = args ?? {};
const units = (Array.isArray(raw) ? raw : (raw.units ?? [])).map((u) =>
  typeof u === 'string' ? { name: u, focus: '' } : u,
);
const BRIEF = raw.brief ?? '';
const OUT_DIR = raw.outDir ?? '';
const MAX_UNITS = raw.maxUnits ?? 9;

if (!units.length || !BRIEF) {
  throw new Error(
    'department-buildout needs a brief and units. Pass args as ' +
      '{brief:"...", units:[{name,focus}|"name"], outDir?:"...", maxUnits?:9}.',
  );
}

const UNIT_SCHEMA = {
  type: 'object',
  required: ['unit', 'document', 'assumptions', 'decisionsNeeded', 'dependencies'],
  properties: {
    unit: { type: 'string' },
    document: { type: 'string', description: 'the full charter/plan in markdown' },
    assumptions: {
      type: 'array',
      description: 'what this author had to assume because the brief did not say',
      items: { type: 'string' },
    },
    decisionsNeeded: {
      type: 'array',
      description: 'decisions only the founder/owner can make, that this unit is blocked on or shaped by',
      items: { type: 'string' },
    },
    dependencies: {
      type: 'array',
      description: 'other units this one depends on, and what it needs from them',
      items: { type: 'string' },
    },
  },
};

// ---------------------------------------------------------------- run

const used = units.slice(0, MAX_UNITS);
if (units.length > used.length) {
  log(`CAP: authoring ${used.length} of ${units.length} units. NOT written: ${units.slice(MAX_UNITS).map((u) => u.name).join(', ')}`);
}

phase('Author');
log(`${used.length} authors: ${used.map((u) => u.name).join(', ')}`);

const written = (
  await parallel(
    used.map((u) => () =>
      agent(
        `You are authoring the "${u.name}" document, one of ${used.length} being written independently and in
parallel from the same brief. You will not see the others, and that is deliberate -- write what
YOUR unit actually requires, even where you suspect it conflicts with a neighbour.

SHARED BRIEF
${BRIEF}

YOUR UNIT: ${u.name}${u.focus ? `\nFOCUS: ${u.focus}` : ''}

Ground the document in this repository: read the code, config, docs and tests that bear on your
unit rather than writing from generic domain knowledge. A charter that could have been written
without opening the repo is not worth having.

Be concrete and specific. Where the brief is silent, make a defensible choice, write it into
"assumptions", and keep going -- do not stall or hedge the document itself. Where a choice is
genuinely not yours to make, put it in "decisionsNeeded" and say what turns on each option.`,
        { label: `author:${u.name}`, phase: 'Author', schema: UNIT_SCHEMA },
      ),
    ),
  )
).filter(Boolean);

log(`${written.length}/${used.length} units authored.`);
if (!written.length) return { units: [], error: 'every author failed' };

// A BARRIER IS CORRECT HERE, and it is the one place in these workflows where it is: the integrator
// compares every unit against every other, so it genuinely needs the complete set at once.
phase('Integrate');

const integrated = await agent(
  `Integrate ${written.length} independently authored units into one coherent plan.

${written
  .map(
    (w) => `### ${w.unit}
ASSUMPTIONS: ${JSON.stringify(w.assumptions)}
DECISIONS NEEDED: ${JSON.stringify(w.decisionsNeeded)}
DEPENDS ON: ${JSON.stringify(w.dependencies)}

${w.document}`,
  )
  .join('\n\n---\n\n')}

Your job is NOT to summarize. Produce:

1. CONFLICTS -- where two units assume incompatible things, or both claim the same responsibility,
   or one's dependency is something another never committed to provide. Quote both sides. If you
   find none, say so explicitly and state what you checked, because "everything agrees" is more
   often a flattened synthesis than a real result.
2. THE BINDING CONSTRAINT -- across all units, what actually gates progress? Argue for it against
   the next most plausible candidate.
3. DECISIONS FOR THE OWNER -- deduplicated across units, each with the options and what each one
   costs or forecloses.
4. CRITICAL PATH -- the ordered sequence, with what can run in parallel alongside it.

${OUT_DIR ? `Write the integrated plan and each unit document under ${OUT_DIR}.` : ''}`,
  { label: 'integrate', phase: 'Integrate' },
);

return {
  units: written.map((w) => ({ unit: w.unit, assumptions: w.assumptions, decisionsNeeded: w.decisionsNeeded })),
  documents: Object.fromEntries(written.map((w) => [w.unit, w.document])),
  integrated,
};
