"""금융감독원(금감원) 분쟁조정사례 수집기 — 뼈대.

수집 결과는 data/cases/ 하위에 case.schema.json 규격의 JSON으로 저장한다.
원칙: 원문에서 추출만 한다. 변환·합산·매핑 금지. 없는 사례를 만들지 않는다.
"""


def fetch_case_list(page: int = 1) -> list[dict]:
    """금감원 분쟁조정사례 목록 한 페이지를 가져온다.

    TODO: e-금융민원센터 분쟁조정사례 목록 요청·파싱 구현
    """
    raise NotImplementedError


def fetch_case_detail(case_url: str) -> dict:
    """사례 상세 페이지에서 원문 텍스트를 가져온다.

    TODO: 상세 페이지 요청·본문 추출 구현
    """
    raise NotImplementedError


def to_case_json(raw: dict) -> dict:
    """원문 데이터를 case.schema.json 규격으로 정리한다.

    출처는 "금감원", 신뢰도등급은 원문 대조 여부에 따라 부여한다.
    TODO: 필드 매핑 구현 (추출만, 내용 생성 금지)
    """
    raise NotImplementedError


def save_cases(cases: list[dict], out_dir: str = "data/cases") -> None:
    """검증을 통과한 사례만 JSON 파일로 저장한다.

    TODO: 스키마 검증 후 저장 구현
    """
    raise NotImplementedError


if __name__ == "__main__":
    print("금감원 수집기 뼈대 - 구현 예정")
