"""The retrieval evaluation set: a corpus, and questions with known answers.

Why a fixture corpus and not the live database. The `minutes` schema currently
holds five approved meetings, three of which are the same recording uploaded
three times, and 237 transcript segments in total. Nothing measurable comes out
of that: a single meeting means every question's answer is in the only meeting
there is, and Hit@K is 1.0 before any retrieval runs. Scope, conflict, and
multi-meeting chronology cannot be tested at all.

So the corpus below is authored, with three exceptions: `weekly`, `hire`, and
`clean` are the transcripts of meetings 1, 2, and 525 of the real database,
copied verbatim including the STT's own noise ("승위는", "어, 네."). They are
what real input looks like, and the authored meetings are what a corpus with
more than one meeting in it looks like. Nothing here is written to the real
schema — see scripts/evaluate.py.

`segments` in a question are line indices into that meeting's `lines`. They were
checked by reading the transcript, not generated.
"""

# Real meetings keep 화자 A / 화자 B, which is what the database actually holds
# for them: nobody renamed their speakers.
CORPUS = [
    {
        "key": "dev1",
        "title": "8월 1주차 개발 회의",
        "held_at": "2026-08-05",
        "speakers": {"SPEAKER_00": "최광훈", "SPEAKER_01": "박서연", "SPEAKER_02": "김태호"},
        "lines": [
            ("SPEAKER_00", "지난주에 이야기한 인증 방식부터 정리하겠습니다."),
            ("SPEAKER_01", "세션 쿠키 기반으로 가는 게 맞다고 봅니다. JWT는 만료 처리가 번거롭습니다."),
            ("SPEAKER_00", "그러면 인증은 세션 쿠키 방식으로 확정하겠습니다."),
            ("SPEAKER_02", "DB는 PostgreSQL 16으로 가는 것으로 결정했습니다."),
            ("SPEAKER_00", "김태호님, SSL 인증서 발급은 금요일까지 처리해 주세요."),
            ("SPEAKER_02", "네, 제가 금요일까지 발급해서 공유하겠습니다."),
            ("SPEAKER_01", "개발 서버 배포는 제가 8월 12일까지 맡겠습니다."),
            ("SPEAKER_00", "그럼 오늘은 여기까지 하겠습니다."),
        ],
        "facts": [
            ("DECISION", "인증은 세션 쿠키 방식으로 확정한다", [2], {"DECIDER": "최광훈"}, None, "DONE"),
            ("DECISION", "DB는 PostgreSQL 16을 사용한다", [3], {"DECIDER": "김태호"}, None, "DONE"),
            ("REQUEST", "SSL 인증서 발급 요청", [4],
             {"REQUESTER": "최광훈", "ASSIGNEE": "김태호"}, "금요일", "UNKNOWN"),
            ("ACTION_ITEM", "SSL 인증서를 금요일까지 발급해 공유", [5],
             {"ASSIGNEE": "김태호"}, "금요일", "UNKNOWN"),
            ("ACTION_ITEM", "개발 서버 배포를 8월 12일까지 진행", [6],
             {"ASSIGNEE": "박서연"}, "8월 12일", "UNKNOWN"),
        ],
    },
    {
        "key": "dev2",
        "title": "8월 2주차 개발 회의",
        "held_at": "2026-08-12",
        "speakers": {"SPEAKER_00": "최광훈", "SPEAKER_01": "박서연", "SPEAKER_02": "김태호"},
        "lines": [
            ("SPEAKER_00", "개발 서버 배포는 완료됐습니다."),
            ("SPEAKER_01", "네, 지난주 금요일에 배포 끝냈습니다."),
            ("SPEAKER_02", "SSL 인증서는 아직 발급이 안 됐습니다. 인증 기관 심사가 남았습니다."),
            ("SPEAKER_00", "그러면 SSL 인증서 담당을 박서연님으로 바꾸겠습니다."),
            ("SPEAKER_01", "네, 제가 이어서 처리하겠습니다."),
            ("SPEAKER_00", "Redis 캐시 서버는 6379 포트로 열어 두겠습니다."),
            ("SPEAKER_02", "모니터링은 다음 회의에서 다시 논의하겠습니다."),
        ],
        "facts": [
            ("DECISION", "SSL 인증서 담당을 박서연으로 변경한다", [3],
             {"DECIDER": "최광훈"}, None, "DONE"),
            ("ACTION_ITEM", "SSL 인증서 발급을 이어서 처리", [4],
             {"ASSIGNEE": "박서연"}, None, "UNKNOWN"),
            ("ACTION_ITEM", "Redis 캐시 서버를 6379 포트로 개방", [5],
             {"ASSIGNEE": "최광훈"}, None, "UNKNOWN"),
        ],
    },
    {
        "key": "dev3",
        "title": "8월 3주차 개발 회의",
        "held_at": "2026-08-19",
        "speakers": {"SPEAKER_00": "최광훈", "SPEAKER_01": "박서연", "SPEAKER_02": "김태호"},
        "lines": [
            ("SPEAKER_00", "인증 방식을 다시 검토했습니다."),
            ("SPEAKER_01", "모바일 앱을 붙이려면 세션 쿠키로는 어렵습니다."),
            ("SPEAKER_00", "그러면 인증은 JWT 토큰 방식으로 변경하겠습니다."),
            ("SPEAKER_02", "DB는 PostgreSQL 16 그대로 갑니다."),
            ("SPEAKER_01", "SSL 인증서는 어제 발급 완료했습니다."),
            ("SPEAKER_00", "부하 테스트는 박서연님이 8월 26일까지 진행해 주세요."),
            ("SPEAKER_01", "네, 8월 26일까지 결과 정리해서 공유하겠습니다."),
        ],
        "facts": [
            ("DECISION", "인증 방식을 JWT 토큰으로 변경한다", [2],
             {"DECIDER": "최광훈"}, None, "DONE"),
            ("REQUEST", "부하 테스트 진행 요청", [5],
             {"REQUESTER": "최광훈", "ASSIGNEE": "박서연"}, "8월 26일", "UNKNOWN"),
            ("ACTION_ITEM", "부하 테스트 결과를 8월 26일까지 정리해 공유", [6],
             {"ASSIGNEE": "박서연"}, "8월 26일", "UNKNOWN"),
        ],
    },
    {
        "key": "infra",
        "title": "인프라 비용 점검 회의",
        "held_at": "2026-08-16",
        "speakers": {"SPEAKER_00": "최광훈", "SPEAKER_01": "이지훈"},
        "lines": [
            ("SPEAKER_01", "GPU 서버 예산은 월 350만원으로 책정되어 있습니다."),
            ("SPEAKER_00", "NCP Object Storage 요금은 얼마 나오고 있습니까?"),
            ("SPEAKER_01", "월 12만원 정도입니다."),
            ("SPEAKER_00", "그러면 전체 인프라 비용은 월 400만원 이내로 유지하는 것으로 하겠습니다."),
            ("SPEAKER_01", "네, 다음 달 청구서 정리해서 8월 29일까지 보고하겠습니다."),
        ],
        "facts": [
            ("DECISION", "전체 인프라 비용을 월 400만원 이내로 유지한다", [3],
             {"DECIDER": "최광훈"}, None, "DONE"),
            ("ACTION_ITEM", "다음 달 청구서를 8월 29일까지 정리해 보고", [4],
             {"ASSIGNEE": "이지훈"}, "8월 29일", "UNKNOWN"),
        ],
    },
    {
        "key": "security",
        "title": "보안 점검 회의",
        "held_at": "2026-08-09",
        "speakers": {"SPEAKER_00": "최광훈", "SPEAKER_01": "김태호"},
        "lines": [
            ("SPEAKER_00", "취약점 점검 결과부터 보겠습니다."),
            ("SPEAKER_01", "SQL 인젝션 관련 이슈는 없었습니다."),
            ("SPEAKER_00", "2차 인증 도입 담당은 김태호님이 맡아 주세요."),
            ("SPEAKER_01", "네, 제가 맡겠습니다."),
            ("SPEAKER_00", "로그 보관 기간은 90일로 하겠습니다."),
        ],
        "facts": [
            ("REQUEST", "2차 인증 도입 담당 요청", [2],
             {"REQUESTER": "최광훈", "ASSIGNEE": "김태호"}, None, "UNKNOWN"),
            ("ACTION_ITEM", "2차 인증 도입을 맡는다", [3], {"ASSIGNEE": "김태호"}, None, "UNKNOWN"),
            ("DECISION", "로그 보관 기간을 90일로 한다", [4], {"DECIDER": "최광훈"}, None, "DONE"),
        ],
    },
    {
        "key": "qa",
        "title": "QA 협의 회의",
        "held_at": "2026-08-10",
        "speakers": {"SPEAKER_00": "박서연", "SPEAKER_01": "이지훈"},
        "lines": [
            ("SPEAKER_01", "2차 인증 도입은 누가 맡기로 했습니까?"),
            ("SPEAKER_00", "2차 인증 도입은 제가 맡기로 했습니다."),
            ("SPEAKER_01", "회귀 테스트 자동화는 9월에 착수하겠습니다."),
        ],
        "facts": [
            ("ACTION_ITEM", "2차 인증 도입을 맡는다", [1], {"ASSIGNEE": "박서연"}, None, "UNKNOWN"),
            ("DECISION", "회귀 테스트 자동화를 9월에 착수한다", [2],
             {"DECIDER": "이지훈"}, None, "DONE"),
        ],
    },
    # ------------------------------------------- verbatim from the real database
    {
        "key": "weekly",
        "title": "주간 개발 회의 (샘플)",
        "held_at": None,
        "speakers": {"SPEAKER_00": "화자 A"},
        "lines": [
            ("SPEAKER_00", "안녕하세요 오늘 주간 개발 회의를 시작하겠습니다."),
            ("SPEAKER_00", "네 지난주 진행 상황부터 말씀드리겠습니다."),
            ("SPEAKER_00", "인덱싱 서비스 리팩터링은 완료했습니다. 좋습니다."),
            ("SPEAKER_00", "그러면 개발 서버 배포 일정은 어떻게 됩니까?"),
            ("SPEAKER_00", "이번주 금요일까지 개발 서버 배포를 마치겠습니다."),
            ("SPEAKER_00", "GPU 서버 예산은 얼마로 잡혀 있나요?"),
            ("SPEAKER_00", "월 350만원으로 책정되어 있습니다."),
            ("SPEAKER_00", "승위는 다음주 화요일에 받을 예정입니다."),
            ("SPEAKER_00", "알겠습니다. 그럼 오늘 회의는 여기서 마치겠습니다."),
        ],
        "facts": [
            ("ACTION_ITEM", "이번주 금요일까지 개발 서버 배포를 마친다", [4],
             {"ASSIGNEE": "화자 A"}, "이번주 금요일", "UNKNOWN"),
            ("DECISION", "GPU 서버 예산은 월 350만원으로 책정한다", [6],
             {"DECIDER": "화자 A"}, None, "DONE"),
        ],
    },
    {
        "key": "hire",
        "title": "8월 채용 회의",
        "held_at": None,
        "speakers": {"SPEAKER_00": "화자 A"},
        "lines": [
            ("SPEAKER_00", "다음 안건은 채용 관련입니다. 백엔드 개발자 채용 진행 상황 공유 부탁드립니다."),
            ("SPEAKER_00", "서류 전형은 12명 통과했고, 기술 면접은 다음 주 수요일부터 시작합니다."),
            ("SPEAKER_00", "최종 합격자 발표 목표 시점은 언제인가요? 9월 15일까지 최종 발표를 목표로 하고 있습니다."),
            ("SPEAKER_00", "네, 채용 예산은 별도로 승인받은 걸로 알고 있습니다. 오늘 회의 마치겠습니다."),
        ],
        "facts": [
            ("DECISION", "최종 합격자 발표를 9월 15일까지 목표로 한다", [2],
             {"DECIDER": "화자 A"}, "9월 15일", "UNKNOWN"),
        ],
    },
    {
        "key": "clean",
        "title": "입주 청소 통화",
        "held_at": None,
        "speakers": {"SPEAKER_00": "화자 A", "SPEAKER_01": "화자 B"},
        "lines": [
            ("SPEAKER_01", "안녕하세요. 혹시 내일 청소 예약하셨을까요?"),
            ("SPEAKER_00", "네, 예약을 해봤습니다."),
            ("SPEAKER_01", "어, 안녕하세요. 어, 잠시만요."),
            ("SPEAKER_01", "그 소리가 너무 안 들려가지고"),
            ("SPEAKER_01", "말씀하시면 됩니다."),
            ("SPEAKER_01", "네, 주소 확인차 연락드렸구요."),
            ("SPEAKER_01", "네."),
            ("SPEAKER_01", "주소가 아파트 맞으실까요?"),
            ("SPEAKER_01", "네, 네."),
            ("SPEAKER_01", "아, 네. 내일 그 2시에서 3시경으로 예약 주셨는데"),
            ("SPEAKER_01", "저희가 오전 청소가 조금 일찍 끝나면 조금 일찍 가거나"),
            ("SPEAKER_01", "조금 늦게 갈 수 있는데 괜찮으실까요?"),
            ("SPEAKER_00", "어, 네. 혹시 그럼 종료시간이 어떻게 되실까요?"),
            ("SPEAKER_01", "어, 보통은 저희가 한 3시간 내외로 걸리는데"),
            ("SPEAKER_01", "저희가 내일 도착했을 때 만약 현장에 오염도가 심하거나"),
            ("SPEAKER_01", "좀 구조가 좀 복잡하거나 그러면 좀 더 걸릴 수 있어서"),
            ("SPEAKER_01", "그거는 도착해서 말씀드릴 수 있을 것 같습니다."),
            ("SPEAKER_00", "아, 그럼 혹시 제가 평소 끝나신 다음에"),
            ("SPEAKER_00", "뭐 잠깐 육안으로 확인을 해야 된다거나 이런 부분이 있을까요?"),
            ("SPEAKER_01", "어, 네. 그러면은 도착, 아니 방문을 하실 예정이신가요?"),
            ("SPEAKER_01", "내일 집에?"),
            ("SPEAKER_00", "어, 거기는 할 건데 지금 집이 비어있는 상태라서"),
            ("SPEAKER_00", "만약에 오후 작업하시고 3시간 정도 걸린다고 하시면"),
            ("SPEAKER_00", "제가 그 집까지 도착하면 한 6시 반 정도 되거든요."),
            ("SPEAKER_00", "아, 네, 네."),
            ("SPEAKER_00", "네, 그래서 한 번 여쭤봤습니다."),
            ("SPEAKER_01", "아, 네. 그러면은 제가 청소 전 후 사진을 꼼꼼하게 좀 찍어서"),
            ("SPEAKER_01", "그 고객님한테 보내드리도록 하고"),
            ("SPEAKER_01", "그리고 제가 뭐 특이사항이나 그런 거 있으면 좀 말씀을 드리도록 하겠습니다."),
            ("SPEAKER_01", "아, 네, 네. 알겠습니다."),
            ("SPEAKER_01", "네, 감사합니다. 그러면은 내일 그 주소, 아니 아니"),
            ("SPEAKER_01", "비밀번호 만약에 현관 비밀번호 있으면 좀 저한테 남겨주시면 감사하겠습니다."),
            ("SPEAKER_00", "아, 네. 그 통화 종료하고 바로 문자로 남겨드리겠습니다."),
            ("SPEAKER_01", "네, 감사합니다. 내일 뵙겠습니다."),
            ("SPEAKER_01", "감사합니다."),
        ],
        "facts": [
            ("REQUEST", "현관 비밀번호를 남겨 달라는 요청", [31],
             {"REQUESTER": "화자 B"}, None, "UNKNOWN"),
            ("ACTION_ITEM", "통화 종료 후 현관 비밀번호를 문자로 전달", [32],
             {"ASSIGNEE": "화자 A"}, None, "UNKNOWN"),
            ("ACTION_ITEM", "청소 전후 사진을 찍어 고객에게 전달", [26, 27],
             {"ASSIGNEE": "화자 B"}, None, "UNKNOWN"),
        ],
    },
]

# question, category, {meeting key: [line indices that hold the answer]}, speaker
QUESTIONS = [
    # ------------------------------------------------------ general semantic
    ("이 회의에서 인증 관련해서 무슨 얘기를 했어?", "general",
     {"dev1": [1, 2], "dev3": [0, 1, 2]}, None),
    ("배포는 어떻게 하기로 했어?", "general",
     {"dev1": [6], "dev2": [0, 1], "weekly": [4]}, None),
    ("비밀번호는 어떻게 전달하기로 했어?", "general", {"clean": [31, 32]}, None),
    ("로그는 얼마나 보관해?", "general", {"security": [4]}, None),
    ("모니터링은 어떻게 됐어?", "general", {"dev2": [6]}, None),
    # ---------------------------------------------------------------- people
    ("SSL 인증서 발급은 누가 하기로 했어?", "person",
     {"dev1": [4, 5], "dev2": [3, 4], "dev3": [4]}, None),
    ("최광훈이 요청한 일이 뭐야?", "person",
     {"dev1": [4], "dev3": [5], "security": [2]}, "최광훈"),
    ("박서연이 맡은 일이 뭐야?", "person",
     {"dev1": [6], "dev2": [4], "dev3": [6], "qa": [1]}, "박서연"),
    ("이지훈이 보고하기로 한 게 뭐야?", "person", {"infra": [4]}, "이지훈"),
    ("누가 부하 테스트를 요청했어?", "person", {"dev3": [5]}, "최광훈"),
    # -------------------------------------------------------------- requests
    ("누가 무엇을 요청했어?", "request",
     {"dev1": [4], "dev3": [5], "security": [2], "clean": [31]}, None),
    ("현관 비밀번호를 누가 요청했어?", "request", {"clean": [31]}, "화자 B"),
    # ------------------------------------------------------------- assignees
    ("부하 테스트 담당이 누구야?", "assignee", {"dev3": [5, 6]}, "박서연"),
    ("Redis 포트 개방은 누가 하기로 했어?", "assignee", {"dev2": [5]}, "최광훈"),
    # ------------------------------------------------------------- decisions
    ("DB는 뭘 쓰기로 결정했어?", "decision", {"dev1": [3], "dev3": [3]}, None),
    ("최종적으로 어떤 인증 방식을 사용하기로 했어?", "decision", {"dev3": [2]}, None),
    ("인프라 비용은 얼마 이내로 유지하기로 했어?", "decision", {"infra": [3]}, None),
    # ----------------------------------------------------------- action items
    ("남은 작업이 뭐야?", "action_item",
     {"dev2": [4], "dev3": [6], "infra": [4]}, None),
    ("해야 할 일이 뭐야?", "action_item", {"dev3": [6], "infra": [4]}, None),
    # ------------------------------------------------------------ due dates
    ("SSL 인증서 발급 기한이 언제야?", "due_date", {"dev1": [4, 5]}, None),
    ("부하 테스트는 언제까지 하기로 했어?", "due_date", {"dev3": [5, 6]}, None),
    ("청구서 보고 기한이 언제야?", "due_date", {"infra": [4]}, None),
    ("채용 최종 발표는 언제까지야?", "due_date", {"hire": [2]}, None),
    ("개발 서버 배포는 언제까지였어?", "due_date", {"dev1": [6], "weekly": [4]}, None),
    # -------------------------------------------------- multi-meeting change
    ("인증 방식 결정이 어떻게 바뀌었어?", "multi_meeting",
     {"dev1": [2], "dev3": [2]}, None),
    ("SSL 인증서 담당이 언제 바뀌었어?", "multi_meeting",
     {"dev1": [4], "dev2": [3]}, None),
    # -------------------------------------------------------------- conflict
    ("2차 인증 도입은 누가 맡기로 했어?", "conflict",
     {"security": [2, 3], "qa": [1]}, None),
    # ------------------------------------------------------------- no answer
    ("회식 장소는 어디로 정했어?", "no_answer", {}, None),
    ("퇴사자 인수인계는 누가 해?", "no_answer", {}, None),
    ("쿠버네티스 클러스터는 몇 개야?", "no_answer", {}, None),
    # ------------------- lexical: an exact term or number, weak for embeddings
    ("Redis 6379 포트 관련 내용", "lexical", {"dev2": [5]}, None),
    ("NCP Object Storage 요금이 얼마야?", "lexical", {"infra": [1, 2]}, None),
    ("PostgreSQL 16", "lexical", {"dev1": [3], "dev3": [3]}, None),
    ("월 350만원", "lexical", {"infra": [0], "weekly": [6]}, None),
    ("서류 전형 12명", "lexical", {"hire": [1]}, None),
    ("로그 보관 90일", "lexical", {"security": [4]}, None),
    # ----------- paraphrase: the answer shares no content word with the question
    ("서버 쓰는 데 돈이 얼마나 들어?", "paraphrase",
     {"infra": [0, 2, 3], "weekly": [6]}, None),
    ("직원 뽑는 건 어떻게 되고 있어?", "paraphrase", {"hire": [0, 1]}, None),
    ("집 청소 끝나는 시간이 언제야?", "paraphrase", {"clean": [13, 14, 15, 16]}, None),
    ("웹 서버 접속 인증을 무엇으로 하기로 했나요?", "paraphrase",
     {"dev1": [2], "dev3": [2]}, None),
    # ------------------------- metadata: the question names a meeting or a date
    ("8월 19일 개발 회의에서 인증에 대해 뭐라고 했어?", "metadata",
     {"dev3": [0, 1, 2]}, None),
    ("8월 2주차 개발 회의에서 Redis 관련 결정이 뭐야?", "metadata", {"dev2": [5]}, None),
    ("보안 점검 회의에서 나온 결정이 뭐야?", "metadata", {"security": [4]}, None),
    ("인프라 비용 점검 회의에서 이지훈이 말한 예산은?", "metadata",
     {"infra": [0]}, "이지훈"),
]

# Questions whose answer differs by meeting. The generator must present both
# rather than pick one, so these are scored on the answer, not on retrieval.
CONFLICT_EXPECT = {
    "2차 인증 도입은 누가 맡기로 했어?": ("김태호", "박서연"),
}
