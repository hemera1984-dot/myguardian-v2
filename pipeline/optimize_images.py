"""케어센터 이미지 최적화 공정.

data/care/issues/ 하위 이미지를 모바일 열람에 맞게 줄인다:
- 최대 폭 1200px 리사이즈
- JPEG(품질 82) 재압축 (알파 채널은 흰 배경 합성)
- 확장자가 바뀌면 issues.json과 각 호 JSON의 참조를 갱신

원본은 git 이력과 CloudFront에 남아 있으므로 파괴적이지 않다.
사용법: python pipeline/optimize_images.py
"""

import json
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
ISSUES_DIR = ROOT / "data" / "care" / "issues"
MAX_WIDTH = 1200
QUALITY = 82


def optimize(path: Path) -> Path | None:
    """이미지를 최적화하고 최종 경로를 반환한다. 실패 시 None."""
    try:
        img = Image.open(path)
    except Exception as e:
        print(f"  열기 실패: {path.name} ({e})")
        return None
    if img.width > MAX_WIDTH:
        ratio = MAX_WIDTH / img.width
        img = img.resize((MAX_WIDTH, int(img.height * ratio)), Image.LANCZOS)
    if img.mode in ("RGBA", "P", "LA"):
        background = Image.new("RGB", img.size, (255, 255, 255))
        background.paste(img.convert("RGBA"), mask=img.convert("RGBA").split()[-1])
        img = background
    elif img.mode != "RGB":
        img = img.convert("RGB")
    out = path.with_suffix(".jpg")
    img.save(out, "JPEG", quality=QUALITY, optimize=True, progressive=True)
    if out != path:
        path.unlink()
    return out


def main() -> None:
    before = sum(f.stat().st_size for f in ISSUES_DIR.rglob("*") if f.is_file())
    renames: dict[str, str] = {}

    for img_path in sorted(ISSUES_DIR.rglob("*")):
        if img_path.suffix.lower() not in (".png", ".jpg", ".jpeg", ".webp", ".gif"):
            continue
        old_rel = str(img_path.relative_to(ROOT)).replace("\\", "/")
        out = optimize(img_path)
        if out is None:
            continue
        new_rel = str(out.relative_to(ROOT)).replace("\\", "/")
        if new_rel != old_rel:
            renames[old_rel] = new_rel

    # 참조 갱신: issues.json (커버이미지) + 각 호 JSON (기사 이미지)
    issues_path = ROOT / "data" / "care" / "issues.json"
    with open(issues_path, encoding="utf-8") as f:
        issues = json.load(f)
    for meta in issues:
        if meta.get("커버이미지") in renames:
            meta["커버이미지"] = renames[meta["커버이미지"]]
    with open(issues_path, "w", encoding="utf-8") as f:
        json.dump(issues, f, ensure_ascii=False, indent=1)

    for issue_file in ISSUES_DIR.glob("*.json"):
        with open(issue_file, encoding="utf-8") as f:
            data = json.load(f)
        changed = False
        for art in data.get("기사", []):
            if art.get("이미지") in renames:
                art["이미지"] = renames[art["이미지"]]
                changed = True
        if changed:
            with open(issue_file, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=1)

    after = sum(f.stat().st_size for f in ISSUES_DIR.rglob("*") if f.is_file())
    print(f"최적화 완료: {before / 1_048_576:.1f} MB → {after / 1_048_576:.1f} MB (참조 갱신 {len(renames)}건)")


if __name__ == "__main__":
    main()
