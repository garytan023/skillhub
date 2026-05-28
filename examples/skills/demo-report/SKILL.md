---
name: demo-report
description: Generate a short internal report from local notes and summarize action items.
allowed-tools:
  - filesystem
  - network
category: office
---

# Demo Report

Use this skill when a team wants to turn local notes into a concise internal report.

## Workflow

1. Read approved local note files.
2. Summarize decisions, blockers, and follow-up owners.
3. Optionally call an internal HTTP API to enrich project metadata.

## Output

Return a short Markdown report with source references.

