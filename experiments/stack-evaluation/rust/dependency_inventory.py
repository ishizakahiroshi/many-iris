"""Verify locked registry crate checksums and report SPDX license expressions."""
import argparse
import hashlib
import io
import json
from pathlib import Path
import tarfile
import tomllib

HERE = Path(__file__).resolve().parent


def inventory(cache):
    result = []
    packages = tomllib.loads((HERE / "Cargo.lock").read_text(encoding="utf-8"))["package"]
    for package in packages:
        if "checksum" not in package:
            continue
        filename = f'{package["name"]}-{package["version"]}.crate'
        files = list((cache / "registry/cache").glob("*/" + filename))
        record = {key: package[key] for key in ("name", "version", "checksum")}
        record.update(license=None, checksum_verified=False)
        if files:
            content = files[0].read_bytes()
            record["checksum_verified"] = hashlib.sha256(content).hexdigest() == package["checksum"]
            if not record["checksum_verified"]:
                raise ValueError(f'Checksum mismatch: {filename}')
            with tarfile.open(fileobj=io.BytesIO(content), mode="r:gz") as archive:
                manifest_name = f'{package["name"]}-{package["version"]}/Cargo.toml'
                manifest = tomllib.loads(archive.extractfile(manifest_name).read().decode())
                record["license"] = manifest["package"].get("license")
                record["license_file"] = manifest["package"].get("license-file")
        result.append(record)
    return dict(packages=result, registry_packages=len(result),
                verified_packages=sum(r["checksum_verified"] for r in result),
                unknown_license_packages=sum(not r["license"] and not r.get("license_file") for r in result),
                note="Checksum and declared license inventory, not a legal or vulnerability audit.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--cache", type=Path, default=HERE / "cargo-cache")
    args = parser.parse_args()
    result = inventory(args.cache)
    (HERE / "dependency-inventory.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({key: value for key, value in result.items() if key != "packages"}))
