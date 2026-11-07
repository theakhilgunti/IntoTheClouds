#!/usr/bin/env python3
"""
Agent Lock & Progress Tracker CLI
Enables multi-agent coordination by locking files/tasks and preventing conflicting edits.
"""

import argparse
import datetime
import json
import os
import re
import sys

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOCK_FILE = os.path.join(ROOT_DIR, ".agent_locks.json")
PROGRESS_MD = os.path.join(ROOT_DIR, "PROGRESS.md")


def load_locks():
    if not os.path.exists(LOCK_FILE):
        return {}
    try:
        with open(LOCK_FILE, "r") as f:
            return json.load(f)
    except Exception:
        return {}


def save_locks(locks):
    with open(LOCK_FILE, "w") as f:
        json.dump(locks, f, indent=2)


def get_current_time():
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d %H:%M UTC")


def cmd_status():
    locks = load_locks()
    print("=" * 60)
    print(" 📋 ACTIVE AGENT LOCKS & WORK IN PROGRESS")
    print("=" * 60)
    if not locks:
        print("  🟢 No active locks. All modules available for work!")
    else:
        for agent, info in locks.items():
            print(f"  🔒 Agent: {agent}")
            print(f"     Task:  {info.get('task')}")
            print(f"     Files: {info.get('files')}")
            print(f"     Since: {info.get('time')}")
            print("-" * 60)
    print("=" * 60)


def cmd_claim(agent: str, task: str, files: str, branch: str = "main"):
    locks = load_locks()
    # Check if files conflict with existing locks
    for other_agent, info in locks.items():
        if other_agent == agent:
            continue
        locked_files = info.get("files", "")
        # Basic check if target overlaps
        if files in locked_files or locked_files in files:
            print(f"❌ CONFLICT ERROR: Files '{files}' are already locked by agent '{other_agent}' for task '{info.get('task')}'!")
            print("Please pick another task or coordinate with your teammate.")
            sys.exit(1)

    time_str = get_current_time()
    locks[agent] = {
        "task": task,
        "files": files,
        "branch": branch,
        "time": time_str,
    }
    save_locks(locks)
    print(f"✅ Claim registered successfully!")
    print(f"   Agent: {agent} -> Task: {task}")
    print(f"   Claimed Files: {files}")
    sync_markdown_progress(locks)


def cmd_release(agent: str, summary: str = "Completed task"):
    locks = load_locks()
    if agent not in locks:
        print(f"⚠️  No active lock found for agent '{agent}'.")
        return

    info = locks.pop(agent)
    save_locks(locks)
    print(f"🔓 Lock released for agent '{agent}' (Task: {info.get('task')}).")
    sync_markdown_progress(locks, released_info=info, agent=agent, summary=summary)


def sync_markdown_progress(locks, released_info=None, agent=None, summary=None):
    if not os.path.exists(PROGRESS_MD):
        return

    try:
        with open(PROGRESS_MD, "r") as f:
            content = f.read()

        # Update Locks Table
        table_rows = []
        if not locks:
            table_rows.append("| *None* | *(No active locks — all modules available)* | — | — | ⚪ Open | — |")
        else:
            for ag, info in locks.items():
                table_rows.append(
                    f"| `{info.get('task')}` | `{info.get('files')}` | {ag} | `{info.get('branch', 'main')}` | 🟡 In Progress | {info.get('time')} |"
                )

        table_str = "\n".join(table_rows)
        # Replace between header and next section
        pattern = r"(## 🔒 Active File & Task Locks \(Claims\)\n\n\|.*?\|\n\|.*?\n)([\s\S]*?)(\n\n---)"
        new_header = r"\1" + table_str + r"\3"
        content = re.sub(pattern, new_header, content)

        # Append to activity log if released
        if released_info and agent:
            time_short = datetime.datetime.now(datetime.timezone.utc).strftime("%H:%M")
            log_entry = f"| {time_short} | {agent} | {released_info.get('task')} | {summary} |\n"
            content += log_entry

        with open(PROGRESS_MD, "w") as f:
            f.write(content)
    except Exception as e:
        print(f"Warning: could not sync PROGRESS.md: {e}")


def main():
    parser = argparse.ArgumentParser(description="Multi-Agent Progress and Lock Manager")
    subparsers = parser.add_subparsers(dest="command", required=True)

    # Status
    subparsers.add_parser("status", help="Show active locks")

    # Claim
    claim_p = subparsers.add_parser("claim", help="Claim a task and lock files")
    claim_p.add_argument("--agent", required=True, help="Agent or developer name")
    claim_p.add_argument("--task", required=True, help="Task ID (e.g. BE-01)")
    claim_p.add_argument("--files", required=True, help="Files or glob path to claim")
    claim_p.add_argument("--branch", default="main", help="Git branch name")

    # Release
    rel_p = subparsers.add_parser("release", help="Release a claimed task")
    rel_p.add_argument("--agent", required=True, help="Agent or developer name")
    rel_p.add_argument("--summary", default="Finished task", help="Summary for activity log")

    args = parser.parse_args()

    if args.command == "status":
        cmd_status()
    elif args.command == "claim":
        cmd_claim(args.agent, args.task, args.files, args.branch)
    elif args.command == "release":
        cmd_release(args.agent, args.summary)


if __name__ == "__main__":
    main()

