#!/usr/bin/env python3
"""Load data/seed_papers.json into the hub through the hub's own write API.

This is the same path an AI agent would use, so it doubles as a worked example of the API.
Needs the web app (and Neo4j) running, with HUB_API_TOKEN set.

  python scripts/seed.py                # add the papers (metadata only)
  python scripts/seed.py --with-pdfs    # also store each item's PDF link (arXiv, UCL): links only, nothing is downloaded
  python scripts/seed.py --copy-to-drive  # with --with-pdfs: download those PDFs and upload them to your Google Drive
  python scripts/seed.py --file my.json # any JSON list of paper items (optional "pdf_url" or "file_url" per item)

Existing papers (same DOI) are skipped, so re-running is safe.
"""
import argparse
import json
import os
import sys
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent


def load_dotenv():
    env = ROOT / ".env"
    if not env.exists():
        return
    for line in env.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def main():
    load_dotenv()
    ap = argparse.ArgumentParser()
    ap.add_argument("--file", default=str(ROOT / "data" / "seed_papers.json"))
    ap.add_argument("--with-pdfs", action="store_true", help="store each item's pdf_url as its file link")
    ap.add_argument("--copy-to-drive", action="store_true", help="also have the server copy those PDFs into your Google Drive (needs Drive set up)")
    ap.add_argument("--url", default=os.environ.get("HUB_URL", "http://127.0.0.1:3000"))
    args = ap.parse_args()

    token = os.environ.get("HUB_API_TOKEN")
    if not token:
        sys.exit("Set HUB_API_TOKEN (the same value the web app was started with).")
    headers = {"Authorization": f"Bearer {token}"}
    items = json.loads(Path(args.file).read_text(encoding="utf-8"))

    created = skipped = failed = 0
    for item in items:
        item = dict(item)
        if not args.with_pdfs:
            item.pop("pdf_url", None)
            item.pop("file_url", None)
        elif args.copy_to_drive:
            item["copy_to_drive"] = True
        try:
            r = requests.post(f"{args.url}/api/papers", json=item, headers=headers, timeout=120)
        except requests.RequestException as e:
            sys.exit(f"Cannot reach the web app at {args.url}: {e}")
        body = r.json() if r.content else {}
        title = item["title"][:70]
        if r.status_code == 201:
            created += 1
            extra = f"  file: {body['file_url']}" if body.get("file_url") else ""
            err = f"  FILE PROBLEM: {body['file_error']}" if body.get("file_error") else ""
            print(f"  created  {body['paper_key']}  {title}{extra}{err}")
        elif r.status_code == 409:
            skipped += 1
            print(f"  exists   {body.get('paper_key')}  {title}")
        else:
            failed += 1
            print(f"  FAILED ({r.status_code}) {title}: {body.get('error', r.text[:200])}")
    print(f"\n{created} created, {skipped} already there, {failed} failed")


if __name__ == "__main__":
    main()
