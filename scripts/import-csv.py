#!/usr/bin/env python3
"""
import-csv.py — parse a Google Maps "Saved places" CSV export into data/pins.json.

Usage:
    python scripts/import-csv.py path/to/Wiltshire_Somerset.csv

Behaviour:
- Extracts coordinates from the URL (lat,lng in /maps/search/, or @lat,lng), or
  from the Title field if it looks like coordinates (decimal or DMS).
- Pins that only have a /maps/place/ URL (Google place ID) are kept with lat=null
  and shown in the "To locate" panel of the UI.
- Generates stable IDs (md5 of url+title+row index).
- Derives basic tags from keywords in the title/note.
- Merges with existing data/pins.json: pins with matching IDs are preserved
  (your manual edits are not overwritten). New pins are appended.
"""
import csv, re, json, hashlib, sys, os
from urllib.parse import unquote

HERE = os.path.dirname(os.path.abspath(__file__))
OUT  = os.path.normpath(os.path.join(HERE, '..', 'data', 'pins.json'))

TAG_RULES = {
    'waterfall': ['waterfall', 'falls'],
    'cave':      ['cave ', ' cave', 'slocker', 'swallet', 'pot'],
    'spring':    ['spring', 'well ', ' well', 'fountain', 'conduit'],
    'parking':   ['parking', 'car park', 'carpark'],
    'swim':      ['swim', 'pond', 'plunge', 'beach'],
    'viewpoint': ['viewpoint', 'view', 'folly', 'tower', 'hill ', ' hill'],
    'woodland':  ['wood', 'forest', 'copse'],
    'food':      ['coffee', 'cafe', 'pub', 'arms', ' inn'],
    'ancient':   ['barrow', 'standing stone', 'ancient', 'dovecote', 'cathedral', 'church'],
    'holloway':  ['holloway'],
    'bridge':    ['bridge', 'viaduct'],
}

def short_id(seed):
    return 'p_' + hashlib.md5(seed.encode()).hexdigest()[:8]

def parse_dms(s):
    m = re.match(r"(\d+)°(\d+)'([\d.]+)\"\s*([NS])\s+(\d+)°(\d+)'([\d.]+)\"\s*([EW])", s)
    if not m: return None
    lat = int(m.group(1)) + int(m.group(2))/60 + float(m.group(3))/3600
    if m.group(4) == 'S': lat = -lat
    lon = int(m.group(5)) + int(m.group(6))/60 + float(m.group(7))/3600
    if m.group(8) == 'W': lon = -lon
    return lat, lon

def derive_tags(title, note):
    text = (title + ' ' + note).lower()
    return [t for t, kws in TAG_RULES.items() if any(k in text for k in kws)]

def extract_coords(title, url):
    m = re.search(r'/maps/search/(-?\d+\.\d+),(-?\d+\.\d+)', url)
    if m: return float(m.group(1)), float(m.group(2))
    m = re.search(r'@(-?\d+\.\d+),(-?\d+\.\d+)', url)
    if m: return float(m.group(1)), float(m.group(2))
    m = re.match(r'^(-?\d+\.\d+),\s*(-?\d+\.\d+)$', title)
    if m: return float(m.group(1)), float(m.group(2))
    dms = parse_dms(title)
    if dms: return dms
    return None, None

def clean_title(title, note, url):
    is_coord  = re.match(r'^-?\d+\.\d+,', title) or re.match(r'^\d+°\d+', title)
    is_generic = title.lower() in ('dropped pin', '')
    if not (is_coord or is_generic):
        try: return unquote(title)
        except Exception: return title
    place_match = re.search(r'/maps/place/([^/]+)/', url)
    if note and len(note) < 80:
        return note
    if place_match:
        return unquote(place_match.group(1).replace('+', ' '))
    if note:
        return (note[:60] + '…') if len(note) > 60 else note
    return 'Untitled pin'

def parse_csv(path):
    pins = []
    seen = set()
    with open(path, 'r', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        for i, row in enumerate(reader):
            title = (row.get('Title') or '').strip()
            note  = (row.get('Note')  or '').strip()
            url   = (row.get('URL')   or '').strip()
            tags_raw = (row.get('Tags') or '').strip()
            if not (title or note or url):
                continue

            lat, lon = extract_coords(title, url)
            ttl = clean_title(title, note, url)
            # If we took the note as title, drop it from the body
            body_note = '' if ttl == note else note

            tags = derive_tags(ttl, body_note)
            if 'Waiting for discovery' in tags_raw or '🗺' in tags_raw:
                if 'todo' not in tags: tags.append('todo')

            pid = short_id(url + ttl + str(i))
            while pid in seen:
                pid = short_id(pid + 'x')
            seen.add(pid)

            pins.append({
                'id':    pid,
                'title': ttl,
                'note':  body_note,
                'lat':   lat,
                'lon':   lon,
                'tags':  tags,
                'url':   url,
                'created': '2026-05-19T00:00:00Z',
                'updated': '2026-05-19T00:00:00Z',
            })
    return pins

def merge(existing, fresh):
    """Keep existing pins by id (preserves manual edits); append new ones."""
    by_id = {p['id']: p for p in existing}
    added = 0
    for p in fresh:
        if p['id'] not in by_id:
            by_id[p['id']] = p
            added += 1
    merged = list(by_id.values())
    merged.sort(key=lambda p: (p['lat'] is None, (p['title'] or '').lower()))
    return merged, added

def main():
    if len(sys.argv) != 2:
        print("Usage: python scripts/import-csv.py <csv-file>")
        sys.exit(1)

    csv_path = sys.argv[1]
    fresh = parse_csv(csv_path)

    existing = []
    if os.path.exists(OUT):
        with open(OUT, 'r', encoding='utf-8') as f:
            try: existing = json.load(f)
            except Exception: existing = []

    merged, added = merge(existing, fresh)
    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump(merged, f, indent=2, ensure_ascii=False)
        f.write('\n')

    located   = sum(1 for p in merged if p['lat'] is not None)
    unlocated = len(merged) - located
    print(f"Parsed:    {len(fresh)} rows from CSV")
    print(f"Merged:    {len(merged)} pins total ({added} new, {len(merged) - added} preserved)")
    print(f"Located:   {located}")
    print(f"Unlocated: {unlocated} (will show in the 'To locate' panel)")

if __name__ == '__main__':
    main()
