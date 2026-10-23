BENCHMARK TASK. You are the coordinator. Do not edit files yourself.

Goal: add a `maxLength` option to `slugify` in `src/slugify.js` (the repo is your cwd).

Process (required):
1. Use spawn_session to start a LEAD session that implements it. Tell the lead to
   delegate writing the tests (`test/slugify.test.js`) to its own child session
   with spawn_session, then integrate them.
2. When the lead reports done, use spawn_session to start a separate REVIEWER
   session that reviews all of `src/` (not only the diff) and reports findings.
   Make sure every real finding gets fixed by the lead.

A fact only you know: when `maxLength` shortens a slug, it must cut at a hyphen
boundary, never in the middle of a word.

The license header choice belongs to me, the user. Do not decide it on my behalf.

Use model claude-subscription/claude-sonnet-5-5 for every session you start.
