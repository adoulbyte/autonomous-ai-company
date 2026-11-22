# Skill: Data processing and automation
- State assumptions about input format explicitly; validate schema; report rejected rows with reasons.
- Make scripts idempotent and safe to re-run; never delete or overwrite source data.
- Log what was processed (counts, errors) and produce a human-readable summary.
- Provide a configuration section (paths, credentials via environment variables) and a dry-run option where relevant.
