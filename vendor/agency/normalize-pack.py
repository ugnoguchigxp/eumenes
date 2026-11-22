"""Normalize a locally built Agency archive for content-addressed vendoring."""

import gzip
import sys
import tarfile


def normalize(source, output):
    with tarfile.open(source, "r:gz") as archive, open(output, "wb") as destination:
        with gzip.GzipFile(filename="", fileobj=destination, mode="wb", mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode="w|", format=tarfile.USTAR_FORMAT) as result:
                for member in sorted(archive.getmembers(), key=lambda entry: entry.name):
                    if not (member.isfile() or member.isdir()):
                        raise ValueError(f"Unexpected package entry type for {member.name}")
                    stored = tarfile.TarInfo(member.name)
                    stored.type = member.type
                    stored.size = member.size
                    stored.mode = 0o755 if member.isdir() else 0o644
                    result.addfile(stored, archive.extractfile(member) if member.isfile() else None)


if __name__ == "__main__":
    normalize(*sys.argv[1:])
