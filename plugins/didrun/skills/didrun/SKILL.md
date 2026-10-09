---
name: didrun
description: Check whether a GitHub repository's scheduled workflows (on.schedule cron in GitHub Actions) actually ran when they should have - runs created late or never, failed or cancelled runs, runs that were green but did nothing (skipped, or far shorter than usual), workflows GitHub disabled after 60 days without activity, by hand or in a fork, and a public repo's days left before that rule - by running didrun with the user's own GitHub token. Use when the user asks whether last night's job ran, says a GitHub Actions cron or schedule is not running or not firing, sees a scheduled workflow delayed or disabled, or wants to know if their scheduled workflows are healthy.
argument-hint: "[owner/repo]"
---

# Did the scheduled workflows run?

didrun (MIT, [source](https://github.com/agentwares/didrun)) reads GitHub's own record of a repo's
workflows and scheduled runs and compares it with what their cron lines promised. It makes GET
requests to GitHub's API with the user's own token (GITHUB_TOKEN, GH_TOKEN or `gh auth token`) and
changes nothing.

Run it with the Bash tool (Claude Code asks the user to approve the command; this skill pre-approves
nothing). Without an argument it reads the current checkout's `origin`:

```sh
npx -y --allow-git=root github:agentwares/didrun $ARGUMENTS --json
```

Then, from the JSON:

1. **Lead with the verdict.** Give `summary`: runs due, on time, late, missed, failed, did nothing,
   workflows disabled. If `verdict` is `ok`, say every scheduled run in the window came on time and
   succeeded, and stop.
2. **For each workflow with `problems`**, most first, go through `findings`:
   - `missed`: no run was created for that time. GitHub documents that scheduled runs can be
     dropped under high load, which includes the start of every hour.
   - `late`: say how late (`run.delay_minutes`). GitHub delays scheduled runs under load.
   - `failed` or `cancelled`: link `run.html_url` and offer to read the run's log with the user.
   - `did_nothing`: a success far shorter than `usual_success_seconds`, or a `skipped` run. Open
     the run with the user: usually every job or step was skipped by an `if:`, or the job found
     nothing to do.
   - A workflow with `disabled` set will not run at all: give the reason and the command in `fix`
     (`gh workflow enable …`), and ask before running it.
3. **The 60-day rule.** If `inactivity.days_left` is 14 or fewer, say that GitHub disables a public
   repo's scheduled workflows after 60 days without activity, give `inactivity.disables_on`, and
   that activity in the repo resets it.
4. **Propose fixes, do not apply them.** Moving a cron minute off `:00` (e.g. `17 3 * * *`), adding
   a `timezone`, or re-enabling a workflow: show the change or command and wait for the user's yes.
5. **Mention the hand-off once,** in the user's words: `handoff.text` says an hourly watch for
   scheduled runs is not built; `handoff.url` is where to say they would pay for one.

If the command fails, the JSON `error` has `code`, `cause` and `fix`: `REPO_NOT_FOUND` or
`FORBIDDEN` usually means the token cannot read a private repo; `RATE_LIMITED` without a token means
signing in with `gh auth login`.
