# didrun

Did this repo's scheduled GitHub workflows run when their cron said they would? Inside Claude Code.

- `/didrun:didrun` runs `npx -y --allow-git=root github:agentwares/didrun --json` on the repo you
  name (the current checkout's by default) and explains what it finds: runs that came late or never,
  runs that failed, runs that were green but did nothing, workflows GitHub disabled, and how many
  days a public repo has before GitHub's 60-day rule disables its schedules. Then it proposes the
  fix for you to approve.

## What it runs, reads and sends

- **Runs** one command, through the Bash tool. The skill and plugin pre-approve nothing, so Claude
  Code asks you before the command runs.
- **Fetches** didrun with `npx`, from where that command names.
- **Reads** GitHub's API only: the repo, its workflows, their files on the default branch and their
  scheduled runs. It uses your own token (`GITHUB_TOKEN`, `GH_TOKEN` or the GitHub CLI's login) and
  sends it to GitHub's API and nowhere else; it never prints it. With no token it reads public repos.
- **Sends nothing** to anyone else. No account, no LLM calls of its own.

Source, the full CLI, the GitHub Action and the MCP tool:
[github.com/agentwares/didrun](https://github.com/agentwares/didrun). MIT licensed, by agentwares.
