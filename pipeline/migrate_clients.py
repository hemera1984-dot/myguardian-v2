"""v1 고객 데이터 → FC별 비공개 고객 저장소 이관 스크립트.

docs/customer-separation.md 설계에 따라 FC 1인당 폴더(저장소) 1개를 만들고,
고객마다 코드 폴더(C-YYYY-NNN)를 생성한다. 폴더명이 곧 진짜 고객코드다.

주의: 산출물에는 고객 개인정보가 들어간다. 반드시 공개 저장소 밖 경로에 생성하고,
      생성된 폴더는 GitHub 비공개 저장소로만 push한다. GitHub Pages 금지.

사용법: python pipeline/migrate_clients.py <백업해제경로> <출력루트>
예:     python pipeline/migrate_clients.py <scratch>/backup-extract C:/projects
        → C:/projects/mg-clients-fc01, mg-clients-fc02, mg-clients-fc03 생성

원칙: 레코드 무변형(추출만). 이 스크립트는 폴더 배치·코드 부여·연결(고객-보험-특약)만 한다.
"""

import json
import sys
from datetime import date
from pathlib import Path

# fcId → 저장소 이름 (v1 fcProfiles 기준)
FC_REPOS = {
    1: "mg-clients-fc01",       # 안창민 (총관리자)
    30001: "mg-clients-fc02",   # 김승은
    60001: "mg-clients-fc03",   # 이지영
}

README = """# 고객 데이터 저장소 ({repo})

- 이 저장소는 비공개 전용이다. public 전환·GitHub Pages 활성화 절대 금지.
- 폴더명 = 고객코드 (C-YYYY-NNN). 폴더명이 곧 진짜 코드다.
- 각 고객 폴더: profile.json(v1 원본 무변형), policies.json(보유보험·특약), memo.md
- 규격: myguardian-v2/data/schema/customer.schema.json 참조
- 이관일: {today} / 출처: insurance_guardian_data_export_20260718
"""


def load(base: Path, name: str):
    with open(base / name, encoding="utf-8") as f:
        d = json.load(f)
    return d if isinstance(d, list) else d.get("data", d.get("rows", []))


def main() -> None:
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)
    export = Path(sys.argv[1]) / "data-export" / "export_output"
    out_root = Path(sys.argv[2])

    customers = load(export, "01_customers.json")
    policies = load(export, "02_customerPolicies.json")
    riders = load(export, "03_policyRiders.json")

    pol_by_cust: dict = {}
    for p in policies:
        pol_by_cust.setdefault(p.get("customerId"), []).append(p)
    riders_by_pol: dict = {}
    for r in riders:
        riders_by_pol.setdefault(r.get("policyId"), []).append(r)

    # 코드 부여: 등록일 순서로 연도별 일련번호
    customers_sorted = sorted(customers, key=lambda c: (c.get("createdAt") or "", c.get("id")))
    seq_by_year: dict = {}
    counts: dict = {}
    for c in customers_sorted:
        year = str(c.get("createdAt") or "2026")[:4]
        seq_by_year[year] = seq_by_year.get(year, 0) + 1
        code = f"C-{year}-{seq_by_year[year]:03d}"

        repo = FC_REPOS.get(c.get("fcId"))
        if repo is None:
            print(f"경고: fcId {c.get('fcId')} 매핑 없음 — 고객 id {c.get('id')} 건너뜀")
            continue
        folder = out_root / repo / code
        folder.mkdir(parents=True, exist_ok=True)

        profile = {"고객코드": code, "이관일": date.today().isoformat(), "v1원본": c}
        with open(folder / "profile.json", "w", encoding="utf-8") as f:
            json.dump(profile, f, ensure_ascii=False, indent=1)

        cust_policies = pol_by_cust.get(c.get("id"), [])
        payload = {
            "policies": cust_policies,
            "riders": [r for p in cust_policies for r in riders_by_pol.get(p.get("id"), [])],
        }
        with open(folder / "policies.json", "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=1)

        memo = c.get("memo") or ""
        with open(folder / "memo.md", "w", encoding="utf-8") as f:
            f.write(f"# 상담 메모 — {code}\n\n{memo}\n")

        counts[repo] = counts.get(repo, 0) + 1

    for repo in FC_REPOS.values():
        repo_dir = out_root / repo
        if repo_dir.exists():
            with open(repo_dir / "README.md", "w", encoding="utf-8") as f:
                f.write(README.format(repo=repo, today=date.today().isoformat()))

    total = sum(counts.values())
    print(f"이관 완료: 총 {total}명 / 보유보험 {len(policies)}건 / 특약 {len(riders)}건")
    for repo, n in counts.items():
        print(f"  {repo}: {n}명")


if __name__ == "__main__":
    main()
