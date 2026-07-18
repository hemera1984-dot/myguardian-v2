"""사례 태깅기 — 뼈대.

data/cases/의 사례 JSON에 쟁점분류·결과·조력자 태그를 부여한다.
원칙: 원문에 근거 없는 태그를 붙이지 않는다. 판단이 어려우면 비워 둔다.
"""


def load_cases(cases_dir: str = "data/cases") -> list[dict]:
    """저장된 사례 JSON을 모두 읽는다.

    TODO: 디렉터리 순회·로드 구현
    """
    raise NotImplementedError


def tag_issue(case: dict) -> str | None:
    """쟁점분류 태그를 부여한다 (예: 알릴의무위반, 암진단확정).

    TODO: 원문 키워드 기반 분류 구현. 근거 없으면 None
    """
    raise NotImplementedError


def tag_helper(case: dict) -> str | None:
    """조력자 태그를 부여한다 (개인단독/설계사조력/손해사정사/소송).

    TODO: 원문 근거 기반 분류 구현. 근거 없으면 None
    """
    raise NotImplementedError


def validate_and_save(cases: list[dict]) -> None:
    """태깅 결과를 스키마 검증 후 저장한다.

    TODO: case.schema.json 검증·저장 구현
    """
    raise NotImplementedError


if __name__ == "__main__":
    print("사례 태깅기 뼈대 - 구현 예정")
