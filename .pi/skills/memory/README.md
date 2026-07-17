# Memory Skill

Project-local memory workflow for pi-web users.

## Files
- `SKILL.md` — skill instructions
- `scripts/memory.py` — CLI implementation
- `$PI_CODING_AGENT_DIR/pi-web-memory.sqlite` (default `~/.pi/agent/`) — database, auto-initialized on first use
- `data/schema.sql` — schema (shipped with the skill)

## Use from repo root
```bash
# Optional: initialize explicitly (normal commands also auto-initialize)
python3 .pi/skills/memory/scripts/memory.py init

# Remember a project fact (always scoped to cwd/project)
python3 .pi/skills/memory/scripts/memory.py add-memory "Prefers tabs over spaces" \
  --category preference --importance 4 --cwd /path/to/project --project my-project

# Search memories for the current project
python3 .pi/skills/memory/scripts/memory.py search "tabs" --project my-project
```
