#!/usr/bin/env python3
"""Interruption-proof orchestration for parallel agents (orkestra kit).

Run by the /orkestra-devam skill after every start, quota stop or network drop:
  orchestrator.py tick                  the 10-minute check: recover stale claims, print status and slots, log it.
  orchestrator.py recover [--dry-run]   take back claims with no sign of life (heartbeat or edit of an owned file)
                                        for stale_claim_minutes: back up and revert their files, release; break
                                        stale locks. Never touches protected owners (SENIOR, İNSAN).
                                        Changes that belong to no claim are backed up and reported, not reverted.
  orchestrator.py verify [--quick]      run orkestra.json checks against everything accepted since tasks/verified;
                                        failing tasks are reopened, unattributable failures become findings.
  orchestrator.py slots                 the work for each agent slot: continue / review / new task / QA / idle.
  orchestrator.py finding "title" "detail" [file ...]   add a finding task to the findings file.
  orchestrator.py push                  push the current branch in seconds: refuses protected branches and a dirty
                                        tree, never runs tests, reports how many commits are not yet verified.
"""
import fnmatch
import importlib.util
import os
import shutil
import signal
import subprocess
import sys
import time
from datetime import datetime

_spec = importlib.util.spec_from_file_location("tasks", os.path.join(os.path.dirname(os.path.abspath(__file__)), "tasks.py"))
tasks = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(tasks)

STALE_LOCK_SECONDS = 10 * 60  # same as orkestra/lock.sh


def root():
    return tasks.ROOT


def git(*args, check=True):
    return subprocess.run(["git", *args], cwd=root(), check=check, capture_output=True, text=True).stdout


LOG_PATH = "docs/orkestra/LOG.md"


def log(line):
    path = os.path.join(root(), LOG_PATH)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "a", encoding="utf-8") as fh:
        fh.write(f"- {datetime.now():%Y-%m-%d %H:%M} orchestrator: {line}\n")


def changed_paths():
    """{path: 'tracked'|'untracked'} for every uncommitted change outside tasks/ state and the orchestrator log."""
    result = {}
    for raw in git("status", "--porcelain=v1", "-uall").splitlines():
        code, path = raw[:2], raw[3:]
        if " -> " in path:
            path = path.split(" -> ", 1)[1]
        path = path.strip('"')
        if path.startswith("tasks/") or path == LOG_PATH:
            continue
        result[path] = "untracked" if code == "??" else "tracked"
    return result


def owns(task, path):
    for pattern in task.files:
        if path == pattern or fnmatch.fnmatch(path, pattern) or (pattern.endswith("/") and path.startswith(pattern)):
            return True
    return False


def claims():
    """[(key, tid, is_review, owner)] for every claim directory."""
    if not os.path.isdir(tasks.CLAIMS):
        return []
    out = []
    for key in sorted(os.listdir(tasks.CLAIMS)):
        if os.path.isdir(os.path.join(tasks.CLAIMS, key)):
            review = key.endswith(tasks.REVIEW_SUFFIX)
            tid = key[: -len(tasks.REVIEW_SUFFIX)] if review else key
            out.append((key, tid, review, tasks.claim_info(key)[0]))
    return out


def alive_at(key, paths):
    """Last sign of life: heartbeat, or the newest edit of a file the claim owns (long commands still count)."""
    beat = tasks.last_beat(key)
    for p in paths:
        full = os.path.join(root(), p)
        if os.path.exists(full):
            beat = max(beat, os.path.getmtime(full))
    return beat


def backup(name, paths, changes, stamp):
    rec = os.path.join(root(), "tasks", "recovery")
    os.makedirs(rec, exist_ok=True)
    tracked = [p for p in paths if changes[p] == "tracked"]
    untracked = [p for p in paths if changes[p] == "untracked"]
    if tracked:
        with open(os.path.join(rec, f"{name}-{stamp}.patch"), "w", encoding="utf-8") as fh:
            fh.write(git("diff", "HEAD", "--", *tracked))
    for p in untracked:
        dest = os.path.join(rec, f"{name}-{stamp}_untracked", p)
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        shutil.copy2(os.path.join(root(), p), dest)
    return tracked, untracked


def recover(dry_run=False):
    all_tasks, _ = tasks.load_tasks()
    changes = changed_paths()
    now = time.time()
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    report = {"recovered": [], "kept": [], "orphans": [], "locks_broken": []}
    claimed_paths = set()
    live_owners = set()  # an agent may hold a lock for a whole long task: its locks live as long as its claims
    for key, tid, review, owner in claims():
        task = all_tasks.get(tid)
        paths = [] if review else [p for p in changes if task and owns(task, p)]
        claimed_paths.update(paths)
        if tasks.is_protected(owner) or now - alive_at(key, paths) < tasks.stale_seconds():
            report["kept"].append(key)
            live_owners.add(tasks.norm(owner))
            continue
        report["recovered"].append(key)
        if dry_run:
            continue
        if paths:
            tracked, untracked = backup(tid, paths, changes, stamp)
            if tracked:
                git("checkout", "HEAD", "--", *tracked)
            for p in untracked:
                os.remove(os.path.join(root(), p))
        tasks.remove_claim(key)
    report["orphans"] = sorted(p for p in changes if p not in claimed_paths)
    if report["orphans"] and not dry_run:
        backup("orphans", report["orphans"], changes, stamp)
    locks = os.path.join(root(), "tasks", "locks")
    if os.path.isdir(locks):
        for name in sorted(os.listdir(locks)):
            d = os.path.join(locks, name)
            if not os.path.isdir(d):
                continue
            try:
                with open(os.path.join(d, "owner"), encoding="utf-8") as fh:
                    owner = fh.read().split("|")[0].strip()
            except OSError:
                owner = "?"
            if tasks.is_protected(owner) or tasks.norm(owner) in live_owners or now - os.path.getmtime(d) < STALE_LOCK_SECONDS:
                continue
            report["locks_broken"].append(name)
            if not dry_run:
                shutil.rmtree(d)
    if not dry_run and (report["recovered"] or report["locks_broken"]):
        log(f"recover: geri alınan {report['recovered']}, kilit {report['locks_broken'] or '-'}, "
            f"sahipsiz değişiklik (yedeklendi, dokunulmadı) {len(report['orphans'])}")
    return report


def run_cmd(cmd):
    """A check that can never block forever: on timeout the whole process group (npm, node…) is killed."""
    def run():
        limit = tasks.CFG["check_timeout_minutes"] * 60
        proc = subprocess.Popen(cmd, cwd=root(), shell=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                text=True, start_new_session=True)
        try:
            output, _ = proc.communicate(timeout=limit)
            return proc.returncode, output[-6000:]
        except subprocess.TimeoutExpired:
            os.killpg(proc.pid, signal.SIGKILL)
            output, _ = proc.communicate()
            return 124, f"{output[-5000:]}\n\nTIMEOUT: `{cmd}` {tasks.CFG['check_timeout_minutes']} dakikada bitmedi; süreç grubu durduruldu."
    return run


def configured_checks(quick):
    checks = [("tasks_lint", run_cmd(f'"{sys.executable}" orkestra/tasks.py lint'))]
    groups = ["quick"] if quick else ["quick", "full"]
    for group in groups:
        for item in tasks.CFG["verify"].get(group, []):
            checks.append((item["name"], run_cmd(item["cmd"])))
    return checks


def verify(checks=None, quick=False):
    marker = os.path.join(root(), "tasks", "verified")
    head = git("rev-parse", "HEAD").strip()
    if not os.path.exists(marker):
        os.makedirs(os.path.dirname(marker), exist_ok=True)
        with open(marker, "w") as fh:
            fh.write(head + "\n")
        log(f"verify: ilk çalıştırma, başlangıç {head[:8]}")
        return {"status": "initialized", "reopened": [], "findings": []}
    with open(marker) as fh:
        base = fh.read().strip()
    added = git("diff", "--name-only", "--diff-filter=A", f"{base}..HEAD", "--", "tasks/done", check=False).split()
    recent = [os.path.basename(p)[:-3] for p in added if p.endswith(".md")]
    all_tasks, _ = tasks.load_tasks()
    result = {"status": "ok", "checked": recent, "reopened": [], "findings": []}
    for name, run in (configured_checks(quick) if checks is None else checks):
        code, output = run()
        if code == 0:
            continue
        result["status"] = "failed"
        owners = [tid for tid in recent if tid in all_tasks and tasks.state(tid) == "done"
                  and any(f in output for f in all_tasks[tid].files)]
        for tid in owners:
            tasks.cmd_reopen(all_tasks, tid, f"orchestrator verify: {name} başarısız\n\n```\n{output[-3000:]}\n```")
            result["reopened"].append(tid)
        if not owners:
            first = next((l.strip() for l in output.splitlines() if l.strip()), "çıktı yok")
            fid = finding(f"Doğrulama: {name} — {first}"[:100], output[-3000:], [])
            if fid:
                result["findings"].append(fid)
    if result["status"] == "ok":
        with open(marker, "w") as fh:
            fh.write(head + "\n")
    log(f"verify {base[:8]}..{head[:8]}: {result['status']}, yeniden açılan {result['reopened'] or '-'}, "
        f"bulgu {result['findings'] or '-'}")
    return result


def slots():
    """Priority per free slot: continue own live claim > review someone else's work > new task > QA > idle."""
    all_tasks, order = tasks.load_tasks()
    now = time.time()
    agents = [f"AGENT_{i}" for i in range(1, tasks.CFG["slots"] + 1)]
    assignment = {}
    for key, tid, review, owner in claims():
        if owner in agents and owner not in assignment and now - tasks.last_beat(key) < tasks.stale_seconds():
            assignment[owner] = ("DEVAM", f"{tid} (inceleme)" if review else tid)
    reviews = [tid for tid in order if tasks.state(tid) == "review"]
    ready = tasks.ready_tasks(all_tasks, order)
    qa_jobs = list(tasks.CFG["qa_jobs"])
    qa = 0
    for agent in agents:
        if agent in assignment:
            continue
        mine = next((tid for tid in reviews if tasks.norm(tasks.maker(tid)) != tasks.norm(agent)), None)
        if mine:
            reviews.remove(mine)
            assignment[agent] = ("İNCELE", mine)
        elif ready:
            assignment[agent] = ("GÖREV", ready.pop(0))
        elif qa_jobs:
            assignment[agent] = ("QA", qa_jobs[qa % len(qa_jobs)])
            qa += 1
        else:
            assignment[agent] = ("BOŞ", "-")
    return [(agent, *assignment[agent]) for agent in agents]


def finding(title, detail, files):
    path = os.path.join(tasks.TASK_DIR, tasks.CFG["finding_file"])
    lo, hi = tasks.CFG["finding_range"]
    os.makedirs(tasks.TASK_DIR, exist_ok=True)
    if not os.path.exists(path):
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(f"# QA ve doğrulama bulguları (T{lo}–T{hi})\n\n"
                     "> `orkestra/orchestrator.py finding` ve QA ajanları yazar. Elle düzenlenebilir; kimlikler sabit kalır.\n")
    with open(path, encoding="utf-8") as fh:
        text = fh.read()
    if f" · {title}\n" in text:
        return None
    all_tasks, _ = tasks.load_tasks()
    free = next((n for n in range(lo, hi + 1) if f"T{n}" not in all_tasks), None)
    if free is None:
        sys.exit(f"finding range T{lo}–T{hi} is full")
    tid = f"T{free}"
    deps = sorted(t.id for t in all_tasks.values() if any(f in t.files for f in files))
    body = "\n".join("    " + l for l in detail.strip().splitlines()[-60:])
    block = (f"\n### {tid} · {title}\n"
             f"- **Bağımlı:** {', '.join(deps) if deps else '—'}\n"
             f"- **Dosyalar:** {', '.join(f'`{f}`' for f in files) if files else '—'}\n"
             f"- **Kaynak:** QA · {datetime.now():%Y-%m-%d %H:%M}\n"
             f"- **İş:** Önce tekrar üret ve otomatik teste çevir, sonra düzelt. Kayıt:\n\n{body}\n\n"
             f"- **Kabul:** Hata tekrar üretilmiyor; `orkestra/orchestrator.py verify --quick` geçiyor.\n")
    with open(path, "a", encoding="utf-8") as fh:
        fh.write(block)
    return tid


def commit(paths, message):
    git("add", "--", *[p for p in paths if os.path.exists(os.path.join(root(), p))], check=False)
    if git("diff", "--cached", "--name-only").strip():
        suffix = tasks.CFG["commit_suffix"]
        git("commit", "-q", "-m", f"{message} {suffix}" if suffix else message)


def unverified_commits():
    """Commits since the last verify marker (None when nothing was ever verified)."""
    marker = os.path.join(root(), "tasks", "verified")
    if not os.path.exists(marker):
        return None
    base = open(marker).read().strip()
    return int(git("rev-list", "--count", f"{base}..HEAD", check=False).strip() or 0)


def push():
    """Push the current branch in seconds. Never runs tests: verification is verify's and review's job."""
    branch = git("branch", "--show-current").strip()
    if not branch or branch in tasks.CFG["protected_branches"]:
        sys.exit(f"push refused: '{branch or 'detached HEAD'}' is protected ({', '.join(tasks.CFG['protected_branches'])})")
    dirty = [p for p in git("status", "--porcelain=v1").splitlines() if p[3:].strip('"') != LOG_PATH]
    if dirty:
        sys.exit("push refused: uncommitted changes (commit or release them first):\n" + "\n".join("  " + p for p in dirty))
    commit([LOG_PATH], "orkestra: log")
    pending = unverified_commits()
    out = subprocess.run(["git", "push", "-u", "origin", branch], cwd=root(), capture_output=True, text=True, timeout=300)
    if out.returncode != 0:
        sys.exit(f"push failed:\n{out.stderr[-2000:]}")
    print(f"pushed {branch} @ {git('rev-parse', '--short', 'HEAD').strip()}")
    if pending is None:
        print("doğrulama: hiç çalışmadı (orchestrator.py verify)")
    elif pending:
        print(f"doğrulama: son verify'dan beri {pending} commit doğrulanmadı (orchestrator.py verify)")
    else:
        print("doğrulama: HEAD doğrulanmış")


def print_recover(r, dry_run):
    print(f"geri alınan: {' '.join(r['recovered']) or '-'}")
    print(f"devam eden (canlı veya korumalı): {' '.join(r['kept']) or '-'}")
    print(f"kırılan kilitler: {' '.join(r['locks_broken']) or '-'}")
    if r["orphans"]:
        done = "deneme, yedeklenmedi" if dry_run else "yedeklendi"
        print(f"sahipsiz değişiklikler ({done}, DOKUNULMADI; senior'ın veya insanın çalışması olabilir):")
        for p in r["orphans"]:
            print("  " + p)


def main(argv):
    cmd = argv[1] if len(argv) > 1 else ""
    if cmd == "tick":
        r = recover()
        print_recover(r, False)
        all_tasks, order = tasks.load_tasks()
        tasks.cmd_status(all_tasks, order)
        rows = slots()
        print("yuvalar:")
        for agent, kind, what in rows:
            print(f"  {agent}  {kind:6} {what}")
        busy = sum(1 for _, kind, _ in rows if kind != "BOŞ")
        log(f"tick: {busy}/{len(rows)} yuva işte, geri alınan {len(r['recovered'])}")
    elif cmd == "recover":
        dry = "--dry-run" in argv
        print_recover(recover(dry_run=dry), dry)
    elif cmd == "verify":
        r = verify(quick="--quick" in argv)
        print(f"doğrulama: {r['status']}; yeniden açılan: {' '.join(r['reopened']) or '-'}; bulgu: {' '.join(r['findings']) or '-'}")
        commit(["tasks/verified", "tasks/done", "tasks/history", "tasks/reopen",
                os.path.relpath(os.path.join(tasks.TASK_DIR, tasks.CFG["finding_file"]), root()),
                LOG_PATH],
               f"orchestrator verify: {r['status']}")
        sys.exit(0 if r["status"] in ("ok", "initialized") else 1)
    elif cmd == "push":
        push()
    elif cmd == "slots":
        for agent, kind, what in slots():
            note = tasks.CFG["qa_jobs"].get(what, "") if kind == "QA" else ""
            print(f"{agent}  {kind:6} {what}{'  — ' + note if note else ''}")
    elif cmd == "finding" and any(a.startswith("--") for a in argv[2:]):
        sys.exit('finding takes positional arguments only: orchestrator.py finding "title" "detail" [file ...]')
    elif cmd == "finding" and len(argv) >= 4:
        print(finding(argv[2], argv[3], argv[4:]) or "zaten kayıtlı")
    else:
        print(__doc__)
        sys.exit(2)


if __name__ == "__main__":
    main(sys.argv)
