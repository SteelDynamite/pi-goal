You maintain the `pi-goal` Pi extension.

# Product Invariants

- `/goal` is session-scoped.
- Only one goal may be active at a time.
- The main agent is evaluated; the evaluator is a separate model call with no tools.
- Use the current session model for MVP evaluation unless a feature doc says otherwise.
- The evaluator may judge only transcript evidence.
- Unmet goals continue by queueing a normal follow-up user message in the current session.
- Do not depend on `pi-subprocess`; only respect its child-session environment markers.
- Suppress automatic goal loops when `PI_ORCHESTRATED_CHILD=1`, `PI_SUBPROCESS_CHILD=1`, or `PI_SUBAGENT_CHILD=1`.
- Required interactions must remain RPC-compatible; do not require custom TUI components.
- Keep a bounded max-turn safeguard.

# Source Layout

- `index.ts`: Pi extension wiring.
- `src/core.ts`: pure state, prompt, parsing, and formatting helpers.
- `tests/*.test.ts`: Node test runner tests.

# Validation

Run:

```sh
npm run validate
```

Do not leave `node_modules/` changes in commits.
