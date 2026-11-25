# claude-live-pane (`hacker-view`)

A live session monitor for Claude Code. It opens a pane beside the chat that shows, in real time:

- **Narration**: what Claude is saying as it streams, or `thinking…`
- **The live window**: code typing itself out as Claude writes files, real diffs at true line numbers for edits, commands with their output, file reads, search results
- **The process log**: every tool call with timestamp, target, result and duration. Click any row to replay that step; click **● back to live** to return
- **Background agents**: one lane per subagent with its status, latest action, tokens and runtime
- **Real token usage**: input, cache reads/writes and output from the model's own responses, plus Claude Code's cost estimate

It uses Claude's own theme colours, so it looks like part of the app in light and dark mode. It only observes; it never blocks or changes a tool call.

## Install

This repository is private: each computer needs a GitHub login that git can use first (`gh auth login`, then `gh auth setup-git`, or an SSH key).

At the prompt of a terminal session (`claude`):

```
/plugin install hacker-view --marketplace jesaias1/claude-live-pane
```

Answer `y` to add the marketplace, then pick the **user** scope so it loads in every session.

From a shell (Windows, macOS or Linux):

```
claude plugin install hacker-view --marketplace jesaias1/claude-live-pane
```

In the desktop app: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `jesaias1/claude-live-pane`, then **Add plugin**.

## Use

The pane opens by itself when a session starts. Type `/hacker` to reopen it.

## Update

```
claude plugin marketplace update claude-live-pane
```
