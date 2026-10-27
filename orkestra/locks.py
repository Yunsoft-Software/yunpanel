#!/usr/bin/env python3
"""Thin wrapper for orkestra/lock.sh."""
import os
import subprocess
import sys

def main():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    lock_sh = os.path.join(root, "orkestra", "lock.sh")

    if len(sys.argv) < 2:
        print("usage: locks.py [acquire|release|break|list] [NAME] [AGENT]")
        sys.exit(2)

    cmd = sys.argv[1]
    args = ["bash", lock_sh, cmd]
    if len(sys.argv) > 2:
        args.append(sys.argv[2])
    if len(sys.argv) > 3:
        args.append(sys.argv[3])

    res = subprocess.run(args)
    sys.exit(res.returncode)

if __name__ == "__main__":
    main()
