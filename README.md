# PingRoom round-robin starter

Create fixtures for 2–6 players, collect played-match scores from a named scorekeeper through PingRoom, and export points standings. Every pair meets once; nobody has two fixtures in the same round. Odd rosters get explicit byes.

This runs a small competition's fixture and result ledger. [Preference ranking](https://github.com/pingroom/starter-preference-ranking) instead collects opinions and derives preference relationships. Played-match scores determine wins, draws and losses in application code.

## Try it offline

Choose **Use this template**, clone your repository, and use Node.js 22 or newer:

```sh
npm ci
npm test
npm run demo
```

The demo uses the pinned `@pingroom/sdk` 0.7.0 with an in-memory transport. It shows recorded results, shared first place, and an unavailable score. Tests and demos need no credentials, phone or network after installation. Installation downloads the pinned dependency; `.npmrc` requires releases to be at least 14 days old. Live phone delivery is not tested.

## Prepare and connect

```sh
cp examples/tournament.json tournament.json
cp config.example.json config.json
```

Edit `tournament.json` before starting. Set `tournamentId`, `title`, `scoreUnit`, and a fixed `players` list. Player IDs are unique lowercase slugs of up to 16 characters; labels use up to 40 printable ASCII characters. Titles allow 60 characters and units 20, without surrounding whitespace. Validate and preview the manifest offline, then connect:

```sh
npm run validate
npm run preview
npm run connect
npm run inspect
```

Install [PingRoom](https://pingroom.io/i), approve the printed pairing link, and choose a **standard private room** containing the scorekeeper. Review the server-defined grant during pairing and grant access to that room. `inspect` lists member UUIDs. Verify the intended person in the app and enter their exact UUID and a local label under `participant` in `config.json`. The competitors are local player IDs; they need not be PingRoom members. Only the configured scorekeeper answers.

Pairing saves ignored `.pingroom/credentials.json`. For an existing registration, copy `.env.example` to `.env` and set **both** `PINGROOM_TOKEN` and `PINGROOM_ROOM`. Process variables take precedence as a complete pair: partial or blank values fail instead of borrowing from `.env` or saved credentials. Use the original asking registration throughout the session.

## Record played matches

`preview` shows rounds, byes and the next fixture. Player IDs determine a reproducible circle schedule; roster input order does not change it. **A/B is display order, not a home/away fairness guarantee.** Rounds contain no dates, venues, time estimates or availability checks.

Wait until the next fixture has been played, then run:

```sh
npm start
```

The Question names A and B and asks for the actual score as `A-B`, such as `2-1`, or exactly `Unknown`. Each score must be an integer from 0 to 99, without signs, leading zeroes or spaces around the hyphen. The server trims responses; this application validates the returned normalized text. A `0-0` answer is a recorded draw. Missing text or `Unknown` is never a draw.

After answering, run `npm start` again to read the existing Question. When the result is `ready`, inspect the next fixture and wait until its match has been played before another invocation. Each run creates at most one Question or reads one existing Question; it never automatically starts the following fixture. Pending or uncertain Questions stay in `currentFixture`; `nextFixture` is null until they resolve. There are at most 15 Questions, each with a 15-minute lifetime.

```sh
npm run status
npm run report
```

These commands read local evidence offline. `report` also saves private `.tournament/report.json`. Paths resolve from the project directory even when the CLI is launched elsewhere.

## Read the standings

Higher score wins. The fixed scoring rule is **win 3 / draw 1 / loss 0**. Rows contain played, won, drawn, lost, points, score for and score against.

- `provisionalStandings` includes only valid reported scores. Unresolved fixtures add no games or points; the zero totals of a player without recorded games do not prove they played and lost.
- `finalStandings` and `firstPlacePlayerIds` remain null until every fixture has a valid score. Unknown, expired, cancelled or invalid answers are preserved and leave the final report incomplete. Later fixtures can still be collected; no unresolved result is silently replaced.
- Equal points share a competition place, such as `1, 1, 3`. Player ID orders tied rows for display only. Score difference is not a tiebreaker, and a completed league may have several first-place players.
- `matches` preserves Question IDs, responder/asking-registration identity, timestamps, normalized score text and the derived outcome. Local JSON is private working state, not a tamper-proof audit log. The program validates attribution, not whether a reported match actually happened or the score was accurate.

Exit codes for `start` and `recover`: `0` complete; `2` incomplete or a newly observed invalid/expired/cancelled answer; `3` ready/pending/interrupted; `4` uncertain creation; `1` error. Offline inspection commands return `0` when they read the report, regardless of its status.

## Recover safely

Every creation intent is saved before sending. A lost response blocks further sends until the original Question is recovered:

```sh
npm run find-id
npm run recover -- EXACT_QUESTION_UUID
```

`find-id` examines a bounded recent list of at most 200 Questions. An empty result does not prove creation failed. Inspect the original registration's Questions in PingRoom if necessary, then recover the exact ID. The full fixture request, room, target, asker, lifetime and observation order must match. Recovery never reposts. Keep the original manifest, configuration, credentials and `.tournament/state.json`.

Run `npm run connect` again to resume a valid pending pairing. If pairing creation is uncertain or its link expires, inspect Connected Agents and resolve or revoke the old robot before archiving only `.pingroom/pairing.json` for new setup. Existing saved credentials are not overwritten. A new registration cannot recover the old registration's Questions.

Private state uses atomic writes and a process lock. If a crash leaves `.tournament/.lock` or `.pingroom/.lock`, confirm the recorded process has stopped before removing only the stale lock. Use one machine and private persistent storage. Never delete uncertain state to force a new send. There is no correction/replay command for terminal scores; preserve the original ledger and reconcile corrections explicitly in your downstream application.

## Adapt it

Change the roster, units and title before the session starts, then keep them fixed. `src/model.js` creates fixtures and derives standings; `src/engine.js` performs one durable collection step. Feed the exported JSON into your own results page or event workflow. There are no venue bookings, player messages, deployments, machine actions or external-action placeholders.

Tests check pair coverage, round conflicts and byes for every supported roster size; standings against 729 independent outcome combinations; ties, unknown scores, attribution, recovery and actual CLI invocations. GitHub Actions runs installation, tests and offline demos on Node 22 and 24.

MIT licensed. See [LICENSE](LICENSE).
