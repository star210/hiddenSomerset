#!/usr/bin/env python3
"""
Import or re-import pins from a Google Maps "Saved Lists" CSV export.

Usage:
    python3 scripts/import-csv.py path/to/Wiltshire_Somerset.csv

- Re-running is idempotent: pins are matched by stable ID (md5 of url+title+row)
  so existing pins (including manual edits and uploaded photos) are preserved.
- Coordinates are extracted from Google Maps URL patterns where present;
  pins with opaque place URLs land in the file with lat=null and need to be
  placed manually via the web UI.
- Tags are derived from keyword matches in title/note. Only the 9 canonical
  tags below are emitted: cave, waterfall, swimming, woodland, spring-well,
  viewpoint, historic, farmshops, holloway.
"""
import csv, json, re, sys, hashlib, pathlib

VALID_TAGS = {
    'cave', 'waterfall', 'swimming', 'woodland', 'spring-well',
    'viewpoint', 'historic', 'farmshops', 'holloway',
}

# Keyword -> canonical tag
KEYWORDS = [
    (r'\bcave\b|\bcaves\b|\bswallet\b|\brift\b',                'cave'),
    (r'\bwaterfall\b|\bcascade\b|\bcataract\b',                 'waterfall'),
    (r'\bswim\b|\bswimming\b|\bbathing\b|\bplunge pool\b|\bwild swim\w*',  'swimming'),
    (r'\bwood\w*|\bforest\b|\bcopse\b|\bgrove\b',               'woodland'),
    (r'\bspring\b|\bwell\b|\bholy well\b|\bchalybeate\b',       'spring-well'),
    (r'\bview\w*|\boverlook\b|\bvista\b|\bhilltop\b|\btrig\b',  'viewpoint'),
    (r'\bancient\b|\bbarrow\b|\btumulus\b|\bhill ?fort\b|\bcastle\b|\bruin\w*|\bstanding stone\w*|\bmegalith\w*|\bchurch\b|\bchapel\b|\bpriory\b|\babbey\b|\biron age\b|\bbronze age\b|\bneolithic\b|\bmedieval\b',  'historic'),
    (r'\bfarm shop\w*|\bfarmshop\w*|\bfarm ?stand\b|\bproduce\b|\bbutchers?\b|\bdairy\b|\bcheese\b',  'farmshops'),
    (r'\bholloway\b|\bsunken lane\b|\bsunken track\b',          'holloway'),
]

def derive_tags(title, note):
    hay = f'{title} {note}'.lower()
    tags = []
    for pat, tag in KEYWORDS:
        if tag in tags: continue
        if re.search(pat, hay):
            tags.append(tag)
    return tags

def extract_coords(url, title):
    if not url:
        return None, None
    # /maps/search/lat,lon
    m = re.search(r'/maps/search/(-?\d{1,2}\.\d+),(-?\d{1,3}\.\d+)', url)
    if m: return float(m.group(1)), float(m.group(2))
    # @lat,lon
    m = re.search(r'@(-?\d{1,2}\.\d+),(-?\d{1,3}\.\d+)', url)
    if m: return float(m.group(1)), float(m.group(2))
    # /maps/dir/.../lat,lon
    m = re.search(r'/(-?\d{1,2}\.\d+),(-?\d{1,3}\.\d+)(?:[/?]|$)', url)
    if m:
        lat, lon = float(m.group(1)), float(m.group(2))
        # Sanity: must be within plausible UK range
        if 49 < lat < 61 and -8 < lon < 2:
            return lat, lon
    # Decimal in title
    m = re.search(r'(-?\d{1,2}\.\d{4,}),\s*(-?\d{1,3}\.\d{4,})', title or '')
    if m: return float(m.group(1)), float(m.group(2))
    return None, None

def stable_id(url, title, row_idx):
    key = f'{url}|{title}|{row_idx}'
    h = hashlib.md5(key.encode()).hexdigest()[:8]
    return f'p_{h}'

def main():
    if len(sys.argv) != 2:
        print('Usage: import-csv.py <path-to.csv>', file=sys.stderr)
        sys.exit(1)
    csv_path = pathlib.Path(sys.argv[1])
    pins_path = pathlib.Path(__file__).parent.parent / 'data' / 'pins.json'

    existing = {}
    if pins_path.exists():
        for p in json.loads(pins_path.read_text()):
            existing[p['id']] = p

    new_pins = []
    new_count = 0
    preserved_count = 0
    rows = list(csv.DictReader(csv_path.open(newline='', encoding='utf-8-sig')))
    for i, row in enumerate(rows):
        title = (row.get('Title') or '').strip()
        url = (row.get('URL') or '').strip()
        note_parts = []
        for k in ('Note', 'Comment'):
            v = (row.get(k) or '').strip()
            if v: note_parts.append(v)
        note = '\n\n'.join(note_parts)
        if not title and not url:
            continue
        pid = stable_id(url, title, i)
        if pid in existing:
            new_pins.append(existing[pid])
            preserved_count += 1
            continue
        lat, lon = extract_coords(url, title)
        tags = derive_tags(title, note)
        # Drop any non-canonical tags
        tags = [t for t in tags if t in VALID_TAGS]
        from datetime import datetime, timezone
        now = datetime.now(timezone.utc).isoformat(timespec='seconds').replace('+00:00','Z')
        new_pins.append({
            'id': pid,
            'title': title or 'Untitled',
            'note': note,
            'lat': lat, 'lon': lon,
            'tags': tags,
            'url': url,
            'photos': [],
            'created': now,
            'updated': now,
        })
        new_count += 1

    # Sort: located first then by title
    new_pins.sort(key=lambda p: (p['lat'] is None, (p.get('title') or '').lower()))

    pins_path.parent.mkdir(parents=True, exist_ok=True)
    pins_path.write_text(json.dumps(new_pins, indent=2) + '\n')

    print(f'{len(new_pins)} pins total ({new_count} new, {preserved_count} preserved)')
    located = sum(1 for p in new_pins if p['lat'] is not None)
    print(f'  located: {located}')
    print(f'  unlocated: {len(new_pins) - located}')

if __name__ == '__main__':
    main()
