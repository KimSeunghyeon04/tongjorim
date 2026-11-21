# 통조림 저장소 작업 지침

통조림은 OpenRouter를 이용해 작가의 지시에 따라 원고를 한 장면 정도 이어 쓰는 한국어 데스크톱용 로컬 웹 앱이다. 제품의 목적과 운영 환경은 [PRODUCT.md](PRODUCT.md)를 기준으로 삼는다.

UI 설계·구현·검증은 데스크톱 브라우저만 대상으로 한다. 모바일 화면과 모바일용 반응형 레이아웃은 지원 범위에서 제외한다.

## 실행

- Node.js 22 이상을 사용한다. 외부 패키지 설치나 빌드 단계 없이 저장소 루트에서 `npm start`를 실행한다. PowerShell에서 `npm.ps1` 실행이 막히면 `npm.cmd start`를 사용한다.
- 기본 주소는 `http://127.0.0.1:4173`이다. `/`는 집필실, `/settings`는 모델 설정이다. 포트는 `PORT`로 바꿀 수 있다.
- 실제 OpenRouter 요청에는 서버 환경 변수 또는 루트의 `.env`에 `OPENROUTER_API_KEY`를 설정한다. 기존 `OPENROUTER_API` 이름도 지원한다. 키는 서버에서만 읽으며 `.env`와 키는 커밋, 로그, 브라우저 코드에 포함하지 않는다.

## 변경 지점

| 영역 | 시작할 파일 |
| --- | --- |
| 로컬 HTTP 서버, 정적 파일, OpenRouter 요청과 스트리밍 | `server.mjs`, `public/completion.js` |
| 집필실과 설정 화면 | `public/writer.html`, `public/writer.js`, `public/writer.css`, `public/settings.html`, `public/settings.js`, `public/settings.css` |
| 메모·로어북 AI 도우미 | `public/writing-assistant.mjs`, `public/writer.js`, `public/research-panel.mjs` |
| 작업공간 저장, 백업·복원, AI 메모 | `public/writing-workspace.mjs`, `public/project-files.mjs`, `public/manuscript-memory.mjs` |
| 원문 검색, 참조 선택, 생성 컨텍스트 | `public/research-panel.mjs`, `public/source-panel.mjs`, `public/retrieval.mjs`, `public/embedding-index.mjs`, `public/writing-context.mjs` |
| 공통 프롬프트와 한도, 모델 옵션과 분류 | `public/writing-config.mjs`, `public/model-options.mjs`, `public/model-classification.mjs` |

## 변경 시 지킬 동작

- 원고와 작품 설정은 브라우저의 `localStorage`에, 임베딩 캐시는 `IndexedDB`에 저장된다. 호스트나 포트가 달라지면 브라우저는 별도의 저장소를 사용한다. QA는 별도 포트와 샘플 작품에서 진행한다.
- 작품 필드를 추가하거나 바꿀 때는 기존 작업공간 로드, `relay-project` 백업과 `relay-settings` 가져오기·내보내기, 다른 탭의 설정 병합에 미치는 영향을 확인한다. 설정 저장이 집필실에서 편집 중인 원고를 덮어쓰지 않도록 하고, 원고 줄바꿈을 정규화할 때는 AI 메모가 읽은 위치도 함께 맞춘다.
- 집필 요청 미리보기와 실제 생성은 `server.mjs`의 `readStreamingPayload`를 공유한다. 참조 한도나 모델 옵션을 바꿀 때는 `writing-config.mjs`, `model-options.mjs`의 공통 정의를 활용하고 화면의 예상치와 서버가 보내는 요청을 함께 확인한다.
- 퇴고와 메모·로어북 도우미의 초안은 화면에서 사용자가 반영을 선택하는 흐름을 유지한다. OpenRouter 요청을 바꿀 때는 브라우저의 스트림 파서와 서버의 오류·중지 처리도 확인한다.
- 브라우저에서 직접 불러오는 JS, CSS 등 정적 파일을 추가하거나 이름을 바꾸면 `server.mjs`의 `assets` 목록도 갱신한다. 로컬 바인딩과 요청의 Host·Origin 검사를 보존한다.

## 검증

- `npm test`로 `test/`의 Node 테스트를 실행한다. 실제 OpenRouter 키나 서버 실행은 필요하지 않다. Windows에서는 필요에 따라 아래 명령의 `npm`도 `npm.cmd`로 실행한다.
- 화면이나 요청 흐름을 점검할 때는 `npm run qa:server`를 실행하고 `http://127.0.0.1:4184`에서 변경한 흐름을 확인한다. 모의 서버는 `qa/write`, `qa/revise`, `qa/memory`, `qa/plan`을 제공하고 요청 본문을 임시 NDJSON 로그에 남긴다. 테스트에는 샘플 원고를 사용한다.
- 검색 변경은 모의 서버가 실행 중인 상태에서 별도 터미널로 `npm run qa:retrieval -- 4184`를 실행한다. QA 기본 포트가 사용 중이면 모의 서버의 `PORT`와 검색 명령의 포트 인자에 같은 빈 포트를 지정한다. 실제 임베딩 품질을 평가할 때는 실제 서버의 포트를 지정한다. 이 경우 OpenRouter 임베딩 요청이 발생하며 비용이 들 수 있다.
