"""Comprobación del runtime de build. Nunca se copia al motor de producción."""
import importlib.util
import json
import sys
import pydantic
import yaml
import pefile
from cybersoc_engine.engines.signature_engine import default_catalog

assert sys.version_info[:3] == (3, 12, 16)
assert all(importlib.util.find_spec(name) is None for name in ("pip", "ensurepip", "tkinter"))
print(json.dumps({"python": sys.version, "signatures": default_catalog().count,
                  "pydantic": pydantic.__version__, "pefile": pefile.__version__,
                  "libyaml": yaml._yaml.get_version_string(), "isolated": sys.flags.isolated}))
