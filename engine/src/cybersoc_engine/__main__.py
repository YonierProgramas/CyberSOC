import sys

from cybersoc_engine.logging_setup import configure_logging
from cybersoc_engine.rpc.server import serve


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8", errors="strict", newline="\n")
    sys.stderr.reconfigure(encoding="utf-8", errors="backslashreplace", newline="\n")
    logger = configure_logging()
    logger.info("Engine started")
    try:
        serve(sys.stdin.buffer, sys.stdout)
    except BrokenPipeError:
        logger.warning("Protocol output closed")
        # Avoid a second flush failure during interpreter shutdown.
        sys.stdout = None
        return 1
    except KeyboardInterrupt:
        logger.info("Engine interrupted")
        return 0
    logger.info("Engine stopped")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
