# Saved multi-agent workflows

Reusable orchestration patterns live in `.claude/workflows/` as scripts, so they are invoked by name
rather than re-authored from memory each time. Re-authoring is where the quality drifts: the
adversarial review that found the permanent-brick bug worked because of specific structural choices
(independent refuters, diverse lenses, majority-kill), and those are exactly the details that get
dropped when a script is rewritten from a one-line description.

Invoke one by name, passing `args`:

```
Workflow({ name: 'adversarial-review', args: { targets: [...] } })
```

---

## `adversarial-review`

**Find → refute → synthesize.** One finder per target file, then independent skeptics attack each
finding before it is reported. This is the pattern behind PR #70 (the creatable permanent brick) and
PR #69 (three deploy-script footguns).

```js
args = {
  targets: [
    { file: 'contracts/src/VaultFactory.sol', lens: 'the oracle allowlist curation gate' },
    'contracts/script/Deploy.s.sol',              // string form gets a generic lens
  ],
  verifiers: 2,        // 1-3; which refutation lenses to use (misread / reachable / mitigated)
  context: '',         // extra briefing, e.g. what changed in this PR and why
  maxTargets: 5,       // caps are LOGGED, never silent
  maxFindings: 6,      // per target
}
```

Returns `{ confirmed, killed, report }`. `killed` is kept deliberately; knowing what was proposed
and refuted is how you tell a thorough review from a lucky one.

**Why it is shaped this way.** A finder pool alone produces plausible-but-wrong findings at a high
rate, and each one costs a human reviewer real time. Three things do the work:

- **Refuters are told that killing the finding is the win.** The burden of proof sits on the
  finding. A verifier that cannot establish the claim votes to refute.
- **Lenses differ rather than repeat.** A wrong finding usually fails in one specific way: it
  misread the code, or it is real but unreachable, or it is already mitigated elsewhere. Identical
  verifiers share blind spots; different ones do not.
- **Ties and verifier failures count against the finding.** Unverified is not the same as confirmed.

Findings refute as soon as their finder returns, so file A's findings are under attack while file B
is still being read. There is no barrier, because refutation needs one finding, never the whole set.

## `department-buildout`

**Author N documents in parallel from one brief, then integrate.** Produced the eight department
charters and the Company Plan. Generalizes to any "write the whole set at once" job: per-vertical
plans, per-subsystem runbooks, per-module threat models.

```js
args = {
  brief: 'the shared context every author works from',
  units: [{ name: 'Security', focus: '...' }, 'Legal'],
  outDir: 'Business/',   // optional; where the integrator writes
  maxUnits: 9,
}
```

Returns `{ units, documents, integrated }`.

**Why it is shaped this way.** Writing N documents in one context makes them blur; later sections
inherit the vocabulary and assumptions of earlier ones, and the set converges on a single voice that
agrees with itself. Independent authors disagree, and the disagreements are the valuable output:
they mark where an unstated assumption is hiding.

So the integrate pass is **not a summarizer**. It hunts for contradictions between units, names the
binding constraint and argues for it against the runner-up, and collects the decisions no author had
standing to make. A synthesis reporting "all units are aligned" has usually just flattened the
signal; the workflow tells the integrator to say what it checked when it finds no conflicts.

This is the one place a barrier is correct: the integrator compares every unit against every other,
so it genuinely needs the complete set.

---

## Adding a workflow

A pattern earns a file here once it has been run twice and worked. Before then it is a script, not a
pattern. When you add one, write down *why* the structure is what it is; a future reader can see
the shape from the code, but not the failure mode it was built to avoid.

Both scripts log their caps (`CAP: reviewing 5 of 8 targets. NOT covered: …`). Keep that habit: a
truncated run that reads as "we covered everything" is worse than one that admits its limits.
