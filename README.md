# pi-goal

Pi extension that adds `/goal`, a session-scoped completion condition that keeps the current agent working until the condition is met.

## Install

```sh
pi install git:github.com/SteelDynamite/pi-goal
```

For local testing:

```sh
pi -e ./index.ts
```

## Usage

Set a goal:

```text
/goal all tests in test/auth pass and npm run lint exits 0
```

Check status:

```text
/goal
```

Clear an active goal:

```text
/goal clear
```

Clear aliases: `stop`, `off`, `reset`, `none`, `cancel`.

## Behavior

- One active goal is allowed per session.
- Setting a goal appends one immutable goal-context message and starts work immediately without changing the system prompt.
- After each completed agent turn, the extension asks the current model to evaluate whether non-supervisor transcript evidence proves the goal is met.
- If the main request or evaluator is aborted, the goal remains active and resumable without evaluation.
- If unmet, the extension atomically appends evaluator guidance and requests one boundary continuation.
- If met, the extension records the goal as achieved and stops looping.
- The evaluator cannot run tools; the agent must surface evidence such as test output, build results, or file counts.

## Bounds

By default, a goal stops after 25 evaluated turns. Include an explicit bound to override it:

```text
/goal npm test exits 0 or stop after 10 turns
```

## Resume and child sessions

Active goals restore with the session. Successful compaction restores a missing immutable context marker before the next request without starting a turn; a legacy resumed session restores it when work next starts. Restoration does not duplicate a surviving marker. Achieved or cleared goals remain as history but do not restart.

Automatic goal behavior is disabled when `PI_ORCHESTRATED_CHILD=1`.

## Development

```sh
npm install
npm run validate
```

## License

MIT
