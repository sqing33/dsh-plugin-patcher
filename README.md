# dsh-plugin-patcher

One place to declare every change this profile needs to keep, and one page to see whether they still hold.

The problem is specific. A third-party plugin in a DSH profile drifts — the harness changes the API it calls, or the plugin ships a version that no longer matches what the profile assumed — and the usual fix is a hand edit of `node_modules`. That edit does not survive: the plugin manager runs `pnpm add` on every install, and anything without a manifest entry behind it gets pruned. So the fix gets repeated, silently, and the profile quietly goes back to being wrong.

This plugin makes the fix declarative. You write down what should be true; the host checks it on every reconcile, tells you when it stopped being true, and puts it back.

## What it can bind

| target | what it changes | who writes it |
| --- | --- | --- |
| `settings` | a path inside another plugin's settings namespace | the host, through the settings service |
| `patch-row` | the `config:` or `disabled:` of a row in the profile's `cordis.patch.yml` | the host, through the plugin manager |
| `package-file` | source inside an installed package | a separate CLI process, never the host |

That last row is the important one, and the restriction is deliberate. A pnpm-installed file is hard-linked into the content-addressable store, so writing it in place corrupts every other copy of that version, and the plugin manager runs under its own lock with its own idea of what the tree should look like. The host therefore only *reads* package files: it reports drift, says what it found, and prints the command that fixes it. That command goes through `pnpm patch`, so the result is a manifest-backed patch that survives the next install.

```bash
node scripts/apply-code-patch.mjs --patch-id reasoning-ladder --pkg dsh-reasoning-effort
```

## The two halves

The browser half owns the spec. It writes it through this plugin's own settings namespace — the same string as the profile row id, so there is one config, one document, and one thing for the host to watch. Every edit bumps a `reconcileNonce`, because a value that does not change is a write the host never sees.

The host half reconciles it. On startup, on any change to its own namespace, and on demand from the page, it recomputes the whole spec from scratch and writes what is missing.

Recomputing everything is the point. One settings write can change which patches exist, what they aim at, and what they expect all at once; there is no cheaper correct answer to "what should this profile look like right now", and a full recomputation also makes the loop idempotent.

## States

| state | meaning |
| --- | --- |
| `in-sync` | the target holds what the patch asks for |
| `drifted` | it does not; re-applying overwrites whatever is there now |
| `pending` | not checked yet |
| `conflict` | two patches claim the same row, a find matches more than once, or something else is writing here |
| `unsupported` | this host cannot do it: a package-file patch with no pinned version, or a version that is not the installed one |
| `absent` | the target is not in this deployment |
| `failed` | the last attempt did not finish; the detail says why |

Turning a patch off rolls it back from the journal, so disabling a patch is also how you undo one. A journal holding half a pair — a crash between the before and the after — is reported as a conflict and *not* rolled back, because the safe reading of a half-written record is that somebody else changed the target after the patch stopped.

## The built-in generator

One patch ships as a generator rather than a fixed value: the reasoning-effort ladder. The list of models to put on the ladder is not known when the spec is written — it is whatever the providers happen to declare when the host reconciles — so the expansion happens where the live value is, in the settings adapter.

```json
{ "$gen": "reasoning-ladder", "args": { "config": { "rungs": ["off", "medium", "high", "xhigh", "max"] } } }
```

## Three examples, from a real profile

`examples/` holds three specs lifted from a profile that had been carrying three hand-edits. They are ordinary specs: open one, copy the text, paste it into the page's import box.

| file | the hand-edit it declares | state on the profile it came from |
| --- | --- | --- |
| `plan-build-switch-command-arity.json` | `dsh-plan-build-switch` calls `commands/execute` with two arguments; the 0.1.7 client contract wants three | `drifted` — this is the one that broke the toggle |
| `subagent-roles-configforms.json` | `dsh-plugin-subagent-roles` binds `ctx.settingsScope`, which 0.1.7 removed | `in-sync` — the profile already carries the patch |
| `think-translate-icons-and-seat.json` | `dsh-think-translate` looks up pre-0.1.7 icon exports that now resolve to null | `in-sync` — carried as a `file:` vendor plus a checksum guard script |

Declaring the second and third is what replaces the guard script. Their fixes were never in the manifest, so nothing was checking them; now the host re-reads both files on every reconcile and says so on the page. The first one is the exception: its fix has to land once, through the CLI.

Every `find` in all three was checked against the package as published and as installed. The two that are already fixed read `in-sync`; the one that is not reads `drifted` and prints the command that lands it.

An edit that inserts is written as "find this anchor, replace it with the anchor plus the new lines", so after it lands the find is still sitting inside its own replacement. The drift check looks for that containment rather than for the find having vanished, otherwise every inserted block would read as still missing and the CLI would insert it twice.

## Installation

```bash
pnpm add dsh-plugin-patcher
```

The bundle registers its own profile row through `cordis.patch.yml`, so there is nothing to add by hand.

## Safety notes

- **Nothing is written without a journal entry first.** If the journal cannot be written, the apply is not attempted.
- **Counts are exact.** A code edit must match exactly once; zero matches and two matches are both refused rather than resolved by guessing.
- **The spec is the only write channel.** Page and host agree on one string, and `scripts/verify-package.mjs` fails if they ever stop agreeing.
- **The host does not run pnpm.** Applying a code patch is a separate process, started by whoever is reading the page.

## Development

```bash
pnpm test     # unit tests, no browser required
pnpm build    # host bundle (esm) and browser bundle (cjs)
pnpm verify   # manifest, bundle and file-shape checks
```

`test/client-bundle.test.ts` evaluates the built browser bundle in a VM the way the host's module loader does, because a bundle that throws while loading looks exactly like a working plugin from the terminal.

## License

MIT