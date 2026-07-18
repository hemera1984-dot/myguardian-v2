"""대법원 판례 수집기 — 뼈대.

수집 결과는 data/cases/ 하위에 case.schema.json 규격의 JSON으로 저장한다.
원칙: 사건번호 없는 판례는 저장하지 않는다. 원문에서 추출만 한다.
"""


def search_precedents(keyword: str, page: int = 1) -> list[dict]:
    """국가법령정보(law.go.kr) 공개 API로 보험 관련 판례를 검색한다.

    TODO: 판례 검색 API 요청·파싱 구현
    """
    raise NotImplementedError


def fetch_precedent_detail(precedent_id: str) -> dict:
    """판례 일련번호로 판결 요지·사건번호·선고일을 가져온다.

    TODO: 판례 본문 API 요청 구현
    """
    raise NotImplementedError


def to_case_json(raw: dict) -> dict:
    """원문 데이터를 case.schema.json 규격으로 정리한다.

    출처는 "대법원". 사건번호가 없으면 None을 반환하고 저장 대상에서 제외한다.
    TODO: 필드 매핑 구현 (추출만, 내용 생성 금지)
    """
    raise NotImplementedError


def save_cases(cases: list[dict], out_dir: str = "data/cases") -> None:
    """사건번호가 있는 판례만 JSON 파일로 저장한다.

    TODO: 스키마 검증 후 저장 구현
    """
    raise NotImplementedError


if __name__ == "__main__":
    print("판례 수집기 뼈대 - 구현 예정")
