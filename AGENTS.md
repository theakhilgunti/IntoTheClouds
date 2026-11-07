# 🤖 Multi-Agent Protocol & Guardrails

> **Mandatory reading for all AI Coding Assistants & Teammates** (Antigravity, Cursor, Claude Code, Copilot, etc.) working on the **IntoTheClouds** repository.

---

## 🛡️ Core Rules for Agents

### Rule 1: The Pre-Flight Check (Read Before Writing)
Before writing or modifying any code in this repository:
1. Open and read [`PROGRESS.md`](./PROGRESS.md).
2. Check the **Active File & Task Locks** table.
3. If the file you intend to edit is claimed by another agent or teammate, **DO NOT MODIFY IT**. Wait or coordinate.

### Rule 2: Claim Before Modifying (Locking)
Never begin editing without declaring your claim:
1. Add an entry to the **Active Locks** table in `PROGRESS.md` or execute:
   ```bash
   python3 scripts/agent_claim.py claim --agent "MyAgentName" --task "BE-01" --files "project/backend/app/fusion/*"
   ```
2. Include the files or directories you are about to touch.

### Rule 3: Respect Domain Boundaries
Stay strictly inside your assigned role's directory tree:
- **Backend / Fusion Math Agents**: Limit modifications to `project/backend/app/**` and `project/backend/tests/**`.
- **Frontend / 3D Visualization Agents**: Limit modifications to `project/frontend/src/**`.
- **Raspberry Pi / Hardware Agents**: Limit modifications to `project/pi_client/**` and hardware docs.

Shared interfaces (like WebSocket message schemas in `project/backend/app/models.py` or `project/frontend/src/types.ts`) must only be modified when explicitly coordinating with both sides.

### Rule 4: Verification Before Release
Before releasing your lock or marking a task done:
- If working on **Backend**: Run `cd project/backend && PYTHONPATH=. .venv/bin/pytest tests/` and verify all tests pass.
- If working on **Frontend**: Run `cd project/frontend && npm run build` and ensure TypeScript and Vite compile with 0 errors.

### Rule 5: Release and Log
1. Remove your claim from the Active Locks table in `PROGRESS.md` or execute:
   ```bash
   python3 scripts/agent_claim.py release --agent "MyAgentName"
   ```
2. Move the task checkbox in `PROGRESS.md` to `[x]`.
3. Add a 1-line entry to the **Activity & Completion Log** with a summary of changes.

---

## 🏷️ Branching & Commit Conventions

When working in Git branches:
- Branch format: `agent/<role>/<task-id>-<brief-slug>`  
  *Example:* `agent/backend/BE-01-rf-tomography`
- Commit message: `<type>(<scope>): [TASK-ID] description`  
  *Example:* `feat(backend): [BE-01] implement ray-casting path attenuation`

