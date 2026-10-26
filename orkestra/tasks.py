#!/usr/bin/env python3
"""Disk-based task board for parallel agents (orkestra kit).

Task blocks live in <task_dir>/*.md (format: docs/orkestra/KURALLAR.md §2). State is files:
  tasks/claims/<ID>/owner          claimed by an agent (atomic mkdir); heartbeat file = last sign of life
  tasks/claims/<ID>@review/owner   an agent is reviewing the submitted work
  tasks/review/<ID>.md             submitted by its maker, waiting for an independent review
  tasks/approval/<ID>.md           review passed, waiting for İNSAN (task has `Onay: İNSAN`)
  tasks/done/<ID>.md               accepted; only now do dependent tasks become ready
  tasks/blocked/<ID>.md            blocked with a reason
  tasks/reopen/<ID>.md             why the task went back to open (old report in tasks/history/)
claims/, locks/ and recovery/ are machine-local (gitignored); everything else is committed.

Usage:
  tasks.py ready                         tasks whose dependencies are accepted
  tasks.py next AGENT                    claim the first ready task and print its id (NONE if none)
  tasks.py claim ID AGENT                claim a task
  tasks.py heartbeat ID AGENT            refresh the claim (task or review) every 5 minutes
  tasks.py release ID AGENT              drop a claim without finishing
  tasks.py done ID AGENT                 submit for review (writes the report template)
  tasks.py review ID AGENT               take the review (never the maker)
  tasks.py accept ID AGENT "note"        review passed
  tasks.py reject ID AGENT "reason"      review failed: back to open with the reason
  tasks.py reopen ID "reason"            accepted work failed verification
  tasks.py block ID AGENT "reason"       mark blocked
  tasks.py unblock ID                    remove the blocked marker
  tasks.py show ID                       task block (+ reopen note)
  tasks.py status                        summary
  tasks.py lint                          ids, dependencies, cycles, file ownership
"""
import json
import os
import re
import sys
import time
from datetime import datetime

DEFAULTS = {
    "slots": 6,
    "task_dir": "docs/gorevler",
    "id_pattern": r"T\d{3,4}[A-Z]?",
    "review": True,
    "protected_owners": ["SENIOR", "İNSAN"],
    "stale_claim_minutes": 20,
    "finding_range": [800, 999],
    "finding_file": "VQ-bulgular.md",
    "verify": {"quick": [], "full": []},
    "qa_jobs": {},
    "commit_suffix": "",
}
REVIEW_SUFFIX = "@review"
FIELD_RE = re.compile(r"^- \*\*([^*]+):\*\*(.*)$")
PATH_RE = re.compile(r"`([^`]+)`")
MAKER_RE = re.compile(r"^Yapan: (\S+)", re.M)


def norm(name):
    """Agent names compared case-insensitively; İNSAN and INSAN are the same agent."""
    return name.strip().replace("İ", "I").replace("ı", "i").upper()


def load_config(root):
    cfg = dict(DEFAULTS)
    path = os.path.join(root, "orkestra.json")
    if os.path.exists(path):
        with open(path, encoding="utf-8") as fh:
            cfg.update(json.load(fh))
    return cfg


def configure(root):
    """Point the module at a project root (tests use a temporary one)."""
    global ROOT, CFG, TASK_DIR, CLAIMS, REVIEW, APPROVAL, DONE, BLOCKED, HISTORY, REOPEN, ID_RE, HEADER_RE
    ROOT = root
    CFG = load_config(root)
    TASK_DIR = os.path.join(root, CFG["task_dir"])
    state_dir = os.path.join(root, "tasks")
    CLAIMS = os.path.join(state_dir, "claims")
    REVIEW = os.path.join(state_dir, "review")
    APPROVAL = os.path.join(state_dir, "approval")
    DONE = os.path.join(state_dir, "done")
    BLOCKED = os.path.join(state_dir, "blocked")
    HISTORY = os.path.join(state_dir, "history")
    REOPEN = os.path.join(state_dir, "reopen")
    ID_RE = re.compile(CFG["id_pattern"])
    HEADER_RE = re.compile(rf"^### ({CFG['id_pattern']}) · (.+)$")


configure(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def stale_seconds():
    return CFG["stale_claim_minutes"] * 60


def is_protected(agent):
    return norm(agent) in {norm(o) for o in CFG["protected_owners"]}


class Task:
    def __init__(self, tid, title, source):
        self.id = tid
        self.title = title
        self.source = source
        self.deps = []
        self.files = []
        self.locks = []
        self.owner = ""
        self.approver = ""
        self.has_acceptance = False
        self.lines = []


def load_tasks():
    tasks, order = {}, []
    if not os.path.isdir(TASK_DIR):
        return tasks, order
    for name in sorted(os.listdir(TASK_DIR)):
        if not name.endswith(".md"):
            continue
        current = None
        with open(os.path.join(TASK_DIR, name), encoding="utf-8") as fh:
            for raw in fh:
                line = raw.rstrip("\n")
                if m := HEADER_RE.match(line):
                    current = Task(m.group(1), m.group(2).strip(), name)
                    if current.id in tasks:
                        sys.exit(f"duplicate task id {current.id} in {name}")
                    tasks[current.id] = current
                    order.append(current.id)
                    current.lines.append(line)
                    continue
                if current is None:
                    continue
                if line.startswith("## ") or line.startswith("# "):
                    current = None
                    continue
                current.lines.append(line)
                m = FIELD_RE.match(line)
                if not m:
                    continue
                key, value = m.group(1).strip(), m.group(2)
                if key == "Bağımlı":
                    current.deps = ID_RE.findall(value)
                elif key == "Dosyalar":
                    current.files = [p.strip() for p in PATH_RE.findall(value)]
                elif key == "Kilit":
                    current.locks = [x.strip() for x in value.split(",") if x.strip()]
                elif key == "Sahip":
                    current.owner = value.strip()
                elif key == "Onay":
                    current.approver = value.strip()
                elif key == "Kabul":
                    current.has_acceptance = bool(value.strip())
    return tasks, order


def report_path(folder, tid):
    return os.path.join(folder, tid + ".md")


def claim_dir(tid, review=False):
    return os.path.join(CLAIMS, tid + (REVIEW_SUFFIX if review else ""))


def state(tid):
    if os.path.exists(report_path(DONE, tid)):
        return "done"
    if os.path.exists(report_path(APPROVAL, tid)):
        return "approval"
    if os.path.exists(report_path(REVIEW, tid)):
        return "reviewing" if os.path.isdir(claim_dir(tid, review=True)) else "review"
    if os.path.exists(report_path(BLOCKED, tid)):
        return "blocked"
    if os.path.isdir(claim_dir(tid)):
        return "claimed"
    return "open"


def claim_info(key):
    """(owner, claimed_at) of a claim directory name (<ID> or <ID>@review)."""
    try:
        with open(os.path.join(CLAIMS, key, "owner"), encoding="utf-8") as fh:
            owner, ts = fh.read().strip().split("|")
        return owner, float(ts)
    except (OSError, ValueError):
        return "?", os.path.getmtime(os.path.join(CLAIMS, key))


def last_beat(key):
    """Most recent sign of life for a claim: heartbeat file mtime, else the claim time."""
    _, claimed_at = claim_info(key)
    beat = os.path.join(CLAIMS, key, "heartbeat")
    if os.path.exists(beat):
        return max(os.path.getmtime(beat), claimed_at)
    return claimed_at


def make_claim(key, agent):
    os.makedirs(CLAIMS, exist_ok=True)
    try:
        os.mkdir(os.path.join(CLAIMS, key))
    except FileExistsError:
        return False
    with open(os.path.join(CLAIMS, key, "owner"), "w", encoding="utf-8") as fh:
        fh.write(f"{agent}|{time.time()}")
    return True


def remove_claim(key):
    claim = os.path.join(CLAIMS, key)
    if os.path.isdir(claim):
        for name in ("owner", "heartbeat"):
            path = os.path.join(claim, name)
            if os.path.exists(path):
                os.remove(path)
        os.rmdir(claim)


def held_claim(tid, agent):
    """The claim key (task or review) that agent holds on tid, or exit."""
    for key in (tid, tid + REVIEW_SUFFIX):
        if os.path.isdir(os.path.join(CLAIMS, key)):
            owner, _ = claim_info(key)
            if norm(owner) == norm(agent):
                return key
    sys.exit(f"{agent} holds no claim on {tid}")


def maker(tid):
    for folder in (REVIEW, APPROVAL, DONE):
        path = report_path(folder, tid)
        if os.path.exists(path):
            with open(path, encoding="utf-8") as fh:
                m = MAKER_RE.search(fh.read())
            return m.group(1) if m else "?"
    return "?"


def get_task(tasks, tid):
    if tid not in tasks:
        sys.exit(f"unknown task {tid}")
    return tasks[tid]


def ready_tasks(tasks, order, agent=None):
    """Open tasks whose dependencies are accepted; owned tasks only for their owner."""
    result = []
    for tid in order:
        t = tasks[tid]
        if state(tid) != "open":
            continue
        if t.owner and (agent is None or norm(t.owner) != norm(agent)):
            continue
        if all(d in tasks and state(d) == "done" for d in t.deps):
            result.append(tid)
    return result


def cmd_claim(tasks, tid, agent):
    t = get_task(tasks, tid)
    if t.owner and norm(t.owner) != norm(agent):
        sys.exit(f"{tid} belongs to {t.owner}")
    missing = [d for d in t.deps if state(d) != "done"]
    if missing:
        sys.exit(f"{tid} not ready, waiting on: {', '.join(missing)}")
    if state(tid) != "open":
        sys.exit(f"{tid} is {state(tid)}")
    if not make_claim(tid, agent):
        owner, _ = claim_info(tid)
        sys.exit(f"{tid} already claimed by {owner}")
    print(f"claimed {tid} by {agent}: {t.title}")


def cmd_heartbeat(tid, agent):
    key = held_claim(tid, agent)
    with open(os.path.join(CLAIMS, key, "heartbeat"), "w", encoding="utf-8") as fh:
        fh.write(f"{time.time()}")
    print(f"heartbeat {key} {agent}")


def cmd_release(tid, agent):
    remove_claim(held_claim(tid, agent))
    print(f"released {tid}")


def cmd_done(tasks, tid, agent):
    t = get_task(tasks, tid)
    if state(tid) != "claimed" or held_claim(tid, agent) != tid:
        sys.exit(f"{tid} must be claimed by {agent} before done (state: {state(tid)})")
    folder = REVIEW if CFG["review"] else DONE
    os.makedirs(folder, exist_ok=True)
    report = report_path(folder, tid)
    with open(report, "w", encoding="utf-8") as fh:
        fh.write(
            f"# {tid} — {t.title}\n"
            f"Yapan: {agent} · Teslim: {datetime.now():%Y-%m-%d %H:%M}\n\n"
            "## Yapılanlar\n\n## Değişen dosyalar\n\n## Doğrulama (komut + çıktı özeti)\n\n"
            "## Bilinen sınırlamalar / sonraki görevlere notlar\n"
        )
    remove_claim(tid)
    where = "review" if CFG["review"] else "done"
    print(f"submitted {tid} for {where} (report: {os.path.relpath(report, ROOT)}) — fill the report, then commit")


def cmd_review(tid, agent):
    if state(tid) != "review":
        sys.exit(f"{tid} is {state(tid)}, not waiting for review")
    if norm(maker(tid)) == norm(agent):
        sys.exit(f"{agent} made {tid}; a different agent must review it")
    if not make_claim(tid + REVIEW_SUFFIX, agent):
        sys.exit(f"{tid} review already taken")
    print(f"reviewing {tid} by {agent} (report: tasks/review/{tid}.md)")


def append(path, text):
    with open(path, "a", encoding="utf-8") as fh:
        fh.write(text)


def review_gate(tid, agent):
    """Check agent may decide on tid's review; return the report path."""
    st = state(tid)
    if norm(maker(tid)) == norm(agent):
        sys.exit(f"{agent} made {tid}; the maker cannot decide its review")
    if st == "approval":
        if norm(agent) != norm("İNSAN"):
            sys.exit(f"{tid} waits for İNSAN approval")
        return report_path(APPROVAL, tid)
    if st == "reviewing":
        owner, _ = claim_info(tid + REVIEW_SUFFIX)
        if norm(owner) != norm(agent) and not is_protected(agent):
            sys.exit(f"{tid} is being reviewed by {owner}")
        return report_path(REVIEW, tid)
    if st == "review":
        if not is_protected(agent):
            sys.exit(f"run `tasks.py review {tid} {agent}` first")
        return report_path(REVIEW, tid)
    sys.exit(f"{tid} is {st}, nothing to review")


def send_back(tid, report, reason, by):
    """Move a report to history and reopen the task with the reason."""
    os.makedirs(HISTORY, exist_ok=True)
    os.makedirs(REOPEN, exist_ok=True)
    os.replace(report, os.path.join(HISTORY, f"{tid}-{datetime.now():%Y%m%d-%H%M%S}.md"))
    with open(report_path(REOPEN, tid), "w", encoding="utf-8") as fh:
        fh.write(f"# {tid} yeniden açıldı · {by} · {datetime.now():%Y-%m-%d %H:%M}\n\n{reason}\n")


def cmd_accept(tasks, tid, agent, note):
    t = get_task(tasks, tid)
    report = review_gate(tid, agent)
    append(report, f"\n## İnceleme — kabul\nİnceleyen: {agent} · {datetime.now():%Y-%m-%d %H:%M}\n\n{note}\n")
    needs_human = t.approver and norm(t.approver) == norm("İNSAN") and norm(agent) != norm("İNSAN")
    dest = APPROVAL if needs_human else DONE
    os.makedirs(dest, exist_ok=True)
    os.replace(report, report_path(dest, tid))
    remove_claim(tid + REVIEW_SUFFIX)
    if os.path.exists(report_path(REOPEN, tid)) and not needs_human:
        os.remove(report_path(REOPEN, tid))
    print(f"accepted {tid} by {agent} -> {'approval (İNSAN onayı bekleniyor)' if needs_human else 'done'}")


def cmd_reject(tasks, tid, agent, reason):
    get_task(tasks, tid)
    report = review_gate(tid, agent)
    append(report, f"\n## İnceleme — ret\nİnceleyen: {agent} · {datetime.now():%Y-%m-%d %H:%M}\n\n{reason}\n")
    send_back(tid, report, f"İnceleme reddi ({agent}):\n\n{reason}", agent)
    remove_claim(tid + REVIEW_SUFFIX)
    print(f"rejected {tid}; back to open")


def cmd_reopen(tasks, tid, reason):
    get_task(tasks, tid)
    report = report_path(DONE, tid)
    if not os.path.exists(report):
        sys.exit(f"{tid} is not done")
    send_back(tid, report, reason, "verify")
    print(f"reopened {tid}")


def cmd_block(tasks, tid, agent, reason):
    get_task(tasks, tid)
    os.makedirs(BLOCKED, exist_ok=True)
    with open(report_path(BLOCKED, tid), "w", encoding="utf-8") as fh:
        fh.write(f"# {tid} — ENGELLENDİ\nAjan: {agent} · {datetime.now():%Y-%m-%d %H:%M}\n\n{reason}\n")
    remove_claim(tid)
    print(f"blocked {tid}")


def waiting_on_blocked(tasks):
    blocked = {tid for tid in tasks if state(tid) == "blocked"}
    waiting, changed = set(), True
    while changed:
        changed = False
        for tid, t in tasks.items():
            if tid in waiting or tid in blocked:
                continue
            if any(d in blocked or d in waiting for d in t.deps):
                waiting.add(tid)
                changed = True
    return waiting


def first_reason(path):
    with open(path, encoding="utf-8") as fh:
        lines = [l.strip() for l in fh.read().splitlines()[2:] if l.strip()]
    return lines[0][:100] if lines else ""


def cmd_status(tasks, order):
    counts = {}
    for tid in order:
        counts[state(tid)] = counts.get(state(tid), 0) + 1
    ready = ready_tasks(tasks, order)
    print(" · ".join(f"{k} {counts.get(k, 0)}" for k in
                     ("open", "claimed", "review", "reviewing", "approval", "blocked", "done"))
          + f" · hazır {len(ready)}")
    now = time.time()
    if os.path.isdir(CLAIMS):
        for key in sorted(os.listdir(CLAIMS)):
            if os.path.isdir(os.path.join(CLAIMS, key)):
                owner, _ = claim_info(key)
                print(f"  claim  {key:14} {owner:10} son sinyal {int((now - last_beat(key)) // 60)} dk önce")
    for tid in order:
        st = state(tid)
        if st in ("review", "approval"):
            print(f"  {st:8} {tid} (yapan {maker(tid)}) {tasks[tid].title}")
        elif st == "blocked":
            print(f"  blocked  {tid}: {first_reason(report_path(BLOCKED, tid))}")
    waiting = waiting_on_blocked(tasks)
    if waiting:
        print(f"  engelli göreve bağlı bekleyenler: {' '.join(sorted(waiting))}")
    own = sorted({tasks[t].owner for t in ready_tasks_all_owners(tasks, order)} - {""})
    if own:
        print(f"  sahipli hazır görevler bekliyor: {', '.join(own)}")


def ready_tasks_all_owners(tasks, order):
    return [tid for tid in order if state(tid) == "open" and tasks[tid].owner
            and all(d in tasks and state(d) == "done" for d in tasks[tid].deps)]


def cmd_lint(tasks, order):
    errors, warnings = [], []
    for t in tasks.values():
        for d in t.deps:
            if d not in tasks:
                errors.append(f"{t.id}: unknown dependency {d}")
        if not t.files and not t.owner:
            warnings.append(f"{t.id}: no Dosyalar line")
        if not t.has_acceptance:
            warnings.append(f"{t.id}: no Kabul line (reviewers need a success criterion)")
    visiting, visited = set(), set()

    def visit(tid, stack):
        if tid in visited:
            return
        if tid in visiting:
            errors.append("cycle: " + " -> ".join(stack + [tid]))
            return
        visiting.add(tid)
        for d in tasks[tid].deps:
            if d in tasks:
                visit(d, stack + [tid])
        visiting.discard(tid)
        visited.add(tid)

    for tid in order:
        visit(tid, [])

    ancestors = {}

    def anc(tid):
        if tid in ancestors:
            return ancestors[tid]
        ancestors[tid] = set()  # guard against cycles (reported separately)
        result = set()
        for d in tasks[tid].deps:
            if d in tasks:
                result.add(d)
                result |= anc(d)
        ancestors[tid] = result
        return result

    # two tasks writing the same concrete file must be ordered (or share a lock)
    writers = {}
    for t in tasks.values():
        for f in t.files:
            if any(c in f for c in "*…<") or f.endswith("/"):
                continue
            writers.setdefault(f, [])
            if t.id not in writers[f]:
                writers[f].append(t.id)
    for f, ids in sorted(writers.items()):
        for i, a in enumerate(ids):
            for b in ids[i + 1:]:
                if a not in anc(b) and b not in anc(a) and not set(tasks[a].locks) & set(tasks[b].locks):
                    errors.append(f"unordered writers of {f}: {a}, {b}")
    print(f"{len(tasks)} tasks")
    for w in warnings:
        print("WARN", w)
    for e in errors:
        print("ERROR", e)
    if errors:
        sys.exit(1)
    print("lint OK")


def warn_if_underparallel(tasks, order):
    active = len(os.listdir(CLAIMS)) if os.path.isdir(CLAIMS) else 0
    waiting = len(ready_tasks(tasks, order)) + sum(1 for tid in order if state(tid) == "review")
    if waiting and active < CFG["slots"]:
        print(f"\n!!! PARALEL ÇALIŞMA UYARISI: {active}/{CFG['slots']} yuva dolu, {waiting} iş bekliyor. "
              "Orkestratör: `python3 orkestra/orchestrator.py slots` çalıştır ve boş yuvalara hemen alt ajan başlat.\n",
              file=sys.stderr)


def main(argv):
    if len(argv) < 2:
        print(__doc__)
        return
    tasks, order = load_tasks()
    cmd, args = argv[1], argv[2:]
    if cmd == "ready":
        for tid in ready_tasks(tasks, order):
            print(f"{tid}  {tasks[tid].title}")
    elif cmd == "next" and len(args) == 1:
        for tid in ready_tasks(tasks, order, agent=args[0]):
            if make_claim(tid, args[0]):
                print(tid)
                warn_if_underparallel(tasks, order)
                return
        print("NONE")
    elif cmd == "claim" and len(args) == 2:
        cmd_claim(tasks, *args)
    elif cmd == "heartbeat" and len(args) == 2:
        cmd_heartbeat(*args)
    elif cmd == "release" and len(args) == 2:
        cmd_release(*args)
    elif cmd == "done" and len(args) == 2:
        cmd_done(tasks, *args)
        warn_if_underparallel(tasks, order)
    elif cmd == "review" and len(args) == 2:
        cmd_review(*args)
    elif cmd == "accept" and len(args) == 3:
        cmd_accept(tasks, *args)
    elif cmd == "reject" and len(args) == 3:
        cmd_reject(tasks, *args)
    elif cmd == "reopen" and len(args) == 2:
        cmd_reopen(tasks, *args)
    elif cmd == "block" and len(args) == 3:
        cmd_block(tasks, *args)
    elif cmd == "unblock" and len(args) == 1:
        os.remove(report_path(BLOCKED, args[0]))
        print(f"unblocked {args[0]}")
    elif cmd == "show" and len(args) == 1:
        print("\n".join(get_task(tasks, args[0]).lines))
        print(f"\ndurum: {state(args[0])}")
        note = report_path(REOPEN, args[0])
        if os.path.exists(note):
            with open(note, encoding="utf-8") as fh:
                print("\n" + fh.read())
    elif cmd == "status":
        cmd_status(tasks, order)
        warn_if_underparallel(tasks, order)
    elif cmd == "lint":
        cmd_lint(tasks, order)
    else:
        print(__doc__)
        sys.exit(2)


if __name__ == "__main__":
    main(sys.argv)
