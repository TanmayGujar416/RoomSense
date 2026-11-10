import json, sys

if len(sys.argv) < 2:
    sys.exit("Usage: python check_site.py <site.json>")

with open(sys.argv[1], "r", encoding="utf-8") as f:
    data = json.load(f)

rooms = set(data.get("rooms", []))
adj = data.get("adjacent", {})
errors = []

for r in rooms:
    if r not in adj:
        errors.append(f"Room '{r}' in 'rooms' has no entry in 'adjacent'")
for r, nbrs in adj.items():
    if r not in rooms:
        errors.append(f"Adjacent key '{r}' not in 'rooms'")
    for n in nbrs:
        if n not in rooms:
            errors.append(f"Neighbour '{n}' of '{r}' not in 'rooms'")
        if n == r:
            errors.append(f"Room '{r}' lists itself as a neighbour")
        if r not in adj.get(n, []):
            errors.append(f"Asymmetry: '{r}' lists '{n}', but '{n}' does not list '{r}'")

if rooms:
    start = next(iter(rooms))
    visited, q = {start}, [start]
    while q:
        curr = q.pop(0)
        for n in adj.get(curr, []):
            if n in rooms and n not in visited:
                visited.add(n)
                q.append(n)
    if visited != rooms:
        errors.append(f"Graph disconnected: unreached {sorted(rooms - visited)}")

if errors:
    print(f"FAILED with {len(errors)} error(s):")
    for err in errors:
        print(f"  - {err}")
    sys.exit(1)

edges = {tuple(sorted([r, n])) for r, nbrs in adj.items() for n in nbrs}
print(f"OK: {len(rooms)} rooms, {len(edges)} connections, graph connected")
