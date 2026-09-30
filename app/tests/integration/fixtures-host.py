"""Keep the team's fixture context alive until the integration test closes stdin."""

import json
import runpy
import sys

sys.stdout.reconfigure(encoding="utf-8")
generator = runpy.run_path(sys.argv[1])["generate_fixtures"]
with generator() as root:
    sys.stdout.write(json.dumps({"root": str(root)}, ensure_ascii=False) + "\n")
    sys.stdout.flush()
    sys.stdin.buffer.readline()
