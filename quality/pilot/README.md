# RepoRecall 1.0 external pilot

The 1.0 pilot is local-first. RepoRecall has no upload endpoint and sends no
background telemetry. Each participant runs paired tasks in fresh sessions,
reviews the generated artifact locally, redacts it, and shares it manually.

Eligibility:

- five independent users;
- five repositories not owned by the RepoRecall builder;
- each repository has at least 500 source files or 50,000 code lines;
- four weeks of use;
- 20 pre-registered tasks per repository, balanced across lookup, bug, trace,
  architecture, and change work.

For each task, write the expected evidence and answer rubric before either arm
runs. Use the same model and settings for the native-tool and fresh-index arms.
Run stale/dirty trust scenarios separately. Blind answer grading to the arm.

The redacted export must not include source code, prompts, absolute paths,
filenames, repository names, or participant identity. Confirmed private misses
become structurally equivalent synthetic fixtures.

The absence of a complete, validated `quality/evidence/pilot-redacted.json`
keeps the 1.0 graph node pending.
