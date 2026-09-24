#!/usr/bin/env bash
# Cold N=15 run per rerank doc-token cap: fresh backup, llm_cache emptied on the copy only.
# usage: [CL=15] [OUT=dir] [INDEX=path] cap.sh <cap|full>...   (QMD_RERANK_MAX_DOC_TOKENS set per run; full = unset)
# Needs `timeout` (coreutils), sqlite3, bun, python3. KB_DIR points dump.ts at the knowledge-base checkout.
set -uo pipefail
H="$(cd "$(dirname "$0")" && pwd)"
cd "$H/../.."
CL="${CL:-15}"
S="${OUT:-${TMPDIR:-/tmp}/rerank-cap}"; mkdir -p "$S"
INDEX="${INDEX:-$HOME/.cache/qmd/index.sqlite}"
for cap in "$@"; do
  db="$S/cap-$cap-n$CL.sqlite"; rm -f "$db"*
  sqlite3 "$INDEX" ".backup $db"
  sqlite3 "$db" "DELETE FROM llm_cache"
  if [ "$cap" = full ]; then env -u QMD_RERANK_MAX_DOC_TOKENS timeout 900 bun "$H/dump.ts" "$db" "$CL" "$S/cap-$cap-n$CL.json" 2>"$S/cap-$cap-n$CL.log"
  else QMD_RERANK_MAX_DOC_TOKENS=$cap timeout 900 bun "$H/dump.ts" "$db" "$CL" "$S/cap-$cap-n$CL.json" 2>"$S/cap-$cap-n$CL.log"; fi
  python3 - "$S/cap-$cap-n$CL.json" "$cap/N$CL" <<'PY'
import json,sys,statistics as st
rows=json.load(open(sys.argv[1]))
stem=lambda f:f.rsplit('/',1)[-1].removesuffix('.md')
hits=0;rec=0;miss=[]
for r in rows:
    rel=[stem(x) for x in r["relevant"]]; seen=[]
    for c in r["candidates"]:
        s=stem(c["file"])
        if s not in seen: seen.append(s)
    top=seen[:5]; f=sum(1 for x in rel if x in top)
    hits+=f>0; rec+=f/len(rel)
    if f==0: miss.append(r["id"])
ms=sorted(r["ms"] for r in rows[1:]); p90=ms[int(round(0.9*(len(ms)-1)))]
print(f"cap={sys.argv[2]:>4} Hit@5={hits/len(rows):.2f} Recall@5={rec/len(rows):.2f} MISS={','.join(miss)} median={st.median(ms):.0f}ms p90={p90:.0f}ms (n={len(ms)})")
PY
done
