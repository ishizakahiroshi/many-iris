"""Validate an explicitly supplied local adapter config, without starting it."""
import argparse
import json
from pathlib import Path

from .adapter import AdapterError, LocalProcessAdapter


def check_config(path):
    source = Path(path)
    if not source.is_file() or source.stat().st_size > 65536:
        raise AdapterError("config_missing_or_too_large")
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise AdapterError("duplicate_config_key")
            result[key] = value
        return result
    try:
        config = json.loads(source.read_text(encoding="utf-8"), object_pairs_hook=unique,
                            parse_constant=lambda _: (_ for _ in ()).throw(AdapterError("invalid_config")))
    except (ValueError, UnicodeError, RecursionError):
        raise AdapterError("invalid_config") from None
    if type(config) is not dict or set(config) - {"command", "cwd", "timeout", "max_output", "enabled"}:
        raise AdapterError("unsupported_config_fields")
    if config.get("enabled", False) is not False:
        raise AdapterError("real_provider_scheduler_not_supported")
    command = config.get("command")
    if command == [] or command is None:
        return {"configured": False, "execution_enabled": False,
                "scheduler_connected": False, "real_provider_verified": False,
                "reason": "explicit_command_required"}
    adapter = LocalProcessAdapter(command, timeout=config.get("timeout", 10),
        max_output=config.get("max_output", 65536), cwd=config.get("cwd"))
    return {**adapter.describe(), "execution_enabled": False,
            "scheduler_connected": False, "validation": "local_configuration_only"}


def main(argv=None):
    parser = argparse.ArgumentParser(description="Check a supplied local adapter configuration; never execute it")
    parser.add_argument("--config", required=True)
    args = parser.parse_args(argv)
    try:
        result = check_config(args.config)
    except (AdapterError, OSError) as error:
        result = {"configured": False, "execution_enabled": False,
                  "error": error.code if isinstance(error, AdapterError) else "config_unreadable"}
        print(json.dumps(result))
        return 2
    print(json.dumps(result))
    return 0 if result["configured"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
